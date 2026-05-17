#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const Busboy = require('busboy');
const { loadSettings, resolveSettings, validateSettings } = require('../cli/settings');
const { convertEpub, convertHtml, cleanup } = require('../cli/converter');
const { VerticalBrowserSession } = require('../cli/browser-renderer');
const { HtmlBrowserSession, isHtmlDocumentInput } = require('../cli/html-renderer');

const rootDir = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 8000);

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon'
};

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendText(res, status, message) {
  send(res, status, { 'Content-Type': 'text/plain; charset=utf-8' }, message);
}

function sanitizeFilename(name) {
  return path.basename(name || 'book.epub').replace(/[^\w.\-()+\s]/g, '_');
}

const verticalSessions = new Map();
const htmlSessions = new Map();
const convertJobs = new Map();

function closeVerticalSession(sessionId) {
  const session = verticalSessions.get(sessionId);
  if (!session) return false;
  verticalSessions.delete(sessionId);
  session.close().catch(() => {});
  return true;
}

function closeHtmlSession(sessionId) {
  const session = htmlSessions.get(sessionId);
  if (!session) return false;
  htmlSessions.delete(sessionId);
  session.close().catch(() => {});
  return true;
}

function getPreviewSession(sessionId) {
  return verticalSessions.get(sessionId) || htmlSessions.get(sessionId) || null;
}

function closePreviewSession(sessionId) {
  if (closeVerticalSession(sessionId)) {
    return true;
  }
  return closeHtmlSession(sessionId);
}

function serializeConvertJob(job) {
  if (!job) return null;

  const total = Number(job.total || 0);
  const current = Number(job.current || 0);
  const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((current / total) * 100))) : 0;

  return {
    jobId: job.jobId,
    status: job.status,
    stage: job.stage,
    message: job.message,
    current,
    total,
    percent,
    pageCount: Number(job.pageCount || total || 0),
    pageTimeMs: Number(job.pageTimeMs || 0),
    elapsedMs: job.startedAt ? Math.max(0, Date.now() - job.startedAt) : 0,
    sourceName: job.sourceName,
    error: job.error || null
  };
}

function cleanupConvertJob(jobId, removeFiles = false) {
  const job = convertJobs.get(jobId);
  if (!job) return false;

  if (job.cleanupTimer) {
    clearTimeout(job.cleanupTimer);
    job.cleanupTimer = null;
  }

  if (removeFiles && job.outputPath && fs.existsSync(job.outputPath)) {
    fs.rmSync(job.outputPath, { force: true });
  }

  if (removeFiles && job.tempDir && fs.existsSync(job.tempDir)) {
    fs.rmSync(job.tempDir, { recursive: true, force: true });
  }

  convertJobs.delete(jobId);
  return true;
}

function updateConvertJob(jobId, patch) {
  const job = convertJobs.get(jobId);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: Date.now() });
  return job;
}

async function startConvertJob(jobId) {
  const job = convertJobs.get(jobId);
  if (!job) return;

  try {
    updateConvertJob(jobId, {
      status: 'running',
      stage: 'init',
      message: 'Opening EPUB...',
      startedAt: Date.now()
    });

    const ext = job.settings.output.format === 'xtch' ? '.xtch' : '.xtc';
    const outputPath = path.join(job.tempDir, path.basename(job.sourceName, path.extname(job.sourceName)) + ext);
    job.outputPath = outputPath;

    const converter = isHtmlDocumentInput(job.sourceName) ? convertHtml : convertEpub;
    const result = await converter(job.epubPath, outputPath, job.settings, (current, total, meta = {}) => {
      const stage = meta.stage || (Number(total) > 0 ? 'render' : 'init');
      const message = meta.message || (stage === 'render' && Number(total) > 0
        ? `Rendering page ${current} / ${total}`
        : job.message);
      updateConvertJob(jobId, {
        stage,
        message,
        current: Number(current) || 0,
        total: Number(total) || 0,
        pageCount: Number(total) || 0,
        pageTimeMs: Number.isFinite(meta.pageTimeMs) ? Math.max(0, Math.round(meta.pageTimeMs)) : 0
      });
    });

    const completed = updateConvertJob(jobId, {
      status: 'done',
      stage: 'done',
      message: 'Conversion complete',
      current: Number(result.pageCount || job.current || 0),
      total: Number(result.pageCount || job.total || 0),
      pageCount: Number(result.pageCount || job.pageCount || 0),
      finishedAt: Date.now()
    });

    if (completed) {
      completed.cleanupTimer = setTimeout(() => {
        cleanupConvertJob(jobId, true);
      }, 6 * 60 * 60 * 1000);
    }
  } catch (err) {
    updateConvertJob(jobId, {
      status: 'error',
      stage: 'error',
      message: err.message,
      error: err.message,
      finishedAt: Date.now()
    });
    const failed = convertJobs.get(jobId);
    if (failed && failed.outputPath && fs.existsSync(failed.outputPath)) {
      fs.rmSync(failed.outputPath, { force: true });
      failed.outputPath = null;
    }
    if (failed && failed.tempDir && fs.existsSync(failed.tempDir)) {
      fs.rmSync(failed.tempDir, { recursive: true, force: true });
    }
  }
}

async function readUploadRequest(req) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epub-xtc-api-'));
  let epubPath = null;
  let settingsJson = '';
  let sourceName = 'book.epub';
  let pendingWrites = 0;
  let busboyClosed = false;

  return await new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });

    function maybeResolve() {
      if (!busboyClosed || pendingWrites > 0) {
        return;
      }

      resolve({
        tempDir,
        epubPath,
        settingsJson,
        sourceName
      });
    }

    busboy.on('file', (fieldname, file, info) => {
      if (fieldname !== 'file') {
        file.resume();
        return;
      }

      sourceName = sanitizeFilename(info && info.filename ? info.filename : 'book.epub');
      epubPath = path.join(tempDir, sourceName);
      const out = fs.createWriteStream(epubPath);
      pendingWrites++;
      file.pipe(out);
      out.on('error', reject);
      out.on('finish', () => {
        pendingWrites--;
        maybeResolve();
      });
    });

    busboy.on('field', (fieldname, value) => {
      if (fieldname === 'settings') {
        settingsJson = value;
      }
    });

    busboy.on('error', reject);

    busboy.on('close', () => {
      busboyClosed = true;
      maybeResolve();
    });

    req.pipe(busboy);
  });
}

async function handleConvertRequest(req, res) {
  let responded = false;
  let upload = null;
  const asyncMode = String(req.headers['x-progress-mode'] || '').toLowerCase() === 'job';
  let jobStarted = false;

  function finish(status, headers, body) {
    if (responded) return;
    responded = true;
    send(res, status, headers, body);
    cleanup();
    if (upload && upload.tempDir && (!asyncMode || !jobStarted)) {
      fs.rmSync(upload.tempDir, { recursive: true, force: true });
    }
  }

  try {
    upload = await readUploadRequest(req);
  } catch (err) {
    finish(500, { 'Content-Type': 'text/plain; charset=utf-8' }, `Upload parse failed: ${err.message}`);
    return;
  }

  const done = async () => {
    if (responded) return;

    try {
      const tempDir = upload.tempDir;
      const epubPath = upload.epubPath;
      const settingsJson = upload.settingsJson;
      const sourceName = upload.sourceName;

      if (!epubPath || !fs.existsSync(epubPath)) {
        finish(400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'No EPUB file uploaded');
        return;
      }

      const configPath = path.join(tempDir, 'settings.json');
      fs.writeFileSync(configPath, settingsJson || '{}', 'utf8');

      const settings = resolveSettings(loadSettings(configPath));
      const errors = validateSettings(settings);
      if (errors.length > 0) {
        finish(400, { 'Content-Type': 'text/plain; charset=utf-8' }, errors.join('\n'));
        return;
      }

      if (asyncMode) {
        const jobId = crypto.randomUUID();
        jobStarted = true;
        convertJobs.set(jobId, {
          jobId,
          status: 'queued',
          stage: 'queued',
          message: 'Queued',
          current: 0,
          total: 0,
          pageCount: 0,
          pageTimeMs: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          tempDir,
          epubPath,
          settings,
          sourceName,
          outputPath: null,
          error: null,
          cleanupTimer: null
        });

        send(res, 202, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store'
        }, JSON.stringify({ jobId }));
        responded = true;
        startConvertJob(jobId).catch((err) => {
          updateConvertJob(jobId, {
            status: 'error',
            stage: 'error',
            message: err.message,
            error: err.message,
            finishedAt: Date.now()
          });
          const failed = convertJobs.get(jobId);
          if (failed && failed.outputPath && fs.existsSync(failed.outputPath)) {
            fs.rmSync(failed.outputPath, { force: true });
            failed.outputPath = null;
          }
          if (failed && failed.tempDir && fs.existsSync(failed.tempDir)) {
            fs.rmSync(failed.tempDir, { recursive: true, force: true });
          }
        });
        return;
      }

      const ext = settings.output.format === 'xtch' ? '.xtch' : '.xtc';
      const outputPath = path.join(tempDir, path.basename(sourceName, path.extname(sourceName)) + ext);
      const converter = isHtmlDocumentInput(sourceName) ? convertHtml : convertEpub;
      const result = await converter(epubPath, outputPath, settings);
      const data = fs.readFileSync(result.outputPath);

      finish(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${path.basename(result.outputPath)}"`,
        'Cache-Control': 'no-store'
      }, data);
    } catch (err) {
      finish(500, { 'Content-Type': 'text/plain; charset=utf-8' }, `Conversion failed: ${err.message}`);
    }
  };

  try {
    await done();
  } finally {
    if (!asyncMode && upload && upload.tempDir) {
      fs.rmSync(upload.tempDir, { recursive: true, force: true });
    }
  }
}

async function handlePreviewSessionCreate(req, res) {
  const upload = await readUploadRequest(req);
  const tempDir = upload.tempDir;
  const epubPath = upload.epubPath;
  const sourceName = upload.sourceName;
  const settingsJson = upload.settingsJson;

  try {
    if (!epubPath || !fs.existsSync(epubPath)) {
      sendText(res, 400, 'No EPUB file uploaded');
      fs.rmSync(tempDir, { recursive: true, force: true });
      return;
    }

    fs.writeFileSync(path.join(tempDir, 'settings.json'), settingsJson || '{}', 'utf8');
    const settings = resolveSettings(loadSettings(path.join(tempDir, 'settings.json')));
    const errors = validateSettings(settings);
    if (errors.length > 0) {
      sendText(res, 400, errors.join('\n'));
      fs.rmSync(tempDir, { recursive: true, force: true });
      return;
    }

    const session = isHtmlDocumentInput(sourceName)
      ? new HtmlBrowserSession(epubPath, settings)
      : new VerticalBrowserSession(epubPath, settings);
    const initInfo = await session.init();
    const sessionId = crypto.randomUUID();
    if (isHtmlDocumentInput(sourceName)) {
      htmlSessions.set(sessionId, session);
    } else {
      verticalSessions.set(sessionId, session);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });

    send(res, 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }, JSON.stringify({
      sessionId,
      pageCount: initInfo.pageCount,
      info: initInfo.info,
      toc: initInfo.toc,
      sourceName
    }));
  } catch (err) {
    sendText(res, 500, `Preview session failed: ${err.message}`);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function safeResolve(requestPath) {
  const decoded = decodeURIComponent(requestPath.split('?')[0]);
  const normalized = path.normalize(decoded).replace(/^([\\/])+/, '');
  const absolute = path.resolve(rootDir, normalized);

  if (!absolute.startsWith(rootDir + path.sep) && absolute !== rootDir) {
    return null;
  }

  return absolute;
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url || '/');
  let requestPath = parsed.pathname || '/';

  if (req.method === 'POST' && requestPath === '/api/preview-session') {
    handlePreviewSessionCreate(req, res).catch((err) => {
      sendText(res, 500, `Preview session failed: ${err.message}`);
    });
    return;
  }

  if (req.method === 'POST' && requestPath === '/api/convert') {
    handleConvertRequest(req, res).catch((err) => {
      sendText(res, 500, `Conversion API failed: ${err.message}`);
    });
    return;
  }

  const convertJobStatusMatch = requestPath.match(/^\/api\/convert-jobs\/([^/]+)$/);
  if (req.method === 'GET' && convertJobStatusMatch) {
    const job = convertJobs.get(convertJobStatusMatch[1]);
    if (!job) {
      sendText(res, 404, 'Conversion job not found');
      return;
    }

    send(res, 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }, JSON.stringify(serializeConvertJob(job)));
    return;
  }

  const convertJobFileMatch = requestPath.match(/^\/api\/convert-jobs\/([^/]+)\/file$/);
  if (req.method === 'GET' && convertJobFileMatch) {
    const jobId = convertJobFileMatch[1];
    const job = convertJobs.get(jobId);
    if (!job) {
      sendText(res, 404, 'Conversion job not found');
      return;
    }

    if (job.status !== 'done' || !job.outputPath || !fs.existsSync(job.outputPath)) {
      sendText(res, 409, 'Conversion job is not finished yet');
      return;
    }

    try {
      const data = fs.readFileSync(job.outputPath);
      send(res, 200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${path.basename(job.outputPath)}"`,
        'Cache-Control': 'no-store'
      }, data);
      cleanupConvertJob(jobId, true);
    } catch (err) {
      sendText(res, 500, `Failed to read converted file: ${err.message}`);
      cleanupConvertJob(jobId, true);
    }
    return;
  }

  if (req.method === 'DELETE' && convertJobStatusMatch) {
    if (cleanupConvertJob(convertJobStatusMatch[1], true)) {
      sendText(res, 200, 'OK');
    } else {
      sendText(res, 404, 'Conversion job not found');
    }
    return;
  }

  const previewMatch = requestPath.match(/^\/api\/preview-session\/([^/]+)\/page\/(\d+)(?:\.png)?$/);
  if (req.method === 'GET' && previewMatch) {
    const sessionId = previewMatch[1];
    const pageIndex = Number(previewMatch[2]);
    const session = getPreviewSession(sessionId);
    if (!session) {
      sendText(res, 404, 'Preview session not found');
      return;
    }
    session.renderPage(pageIndex).then((png) => {
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store'
      });
      res.end(png);
    }).catch((err) => {
      sendText(res, 500, `Preview render failed: ${err.message}`);
    });
    return;
  }

  const previewDeleteMatch = requestPath.match(/^\/api\/preview-session\/([^/]+)$/);
  if (req.method === 'DELETE' && previewDeleteMatch) {
    const sessionId = previewDeleteMatch[1];
    if (closePreviewSession(sessionId)) {
      sendText(res, 200, 'OK');
    } else {
      sendText(res, 404, 'Preview session not found');
    }
    return;
  }

  if (requestPath === '/') {
    res.writeHead(302, { Location: '/web/' });
    res.end();
    return;
  }

  if (requestPath === '/web') {
    res.writeHead(302, { Location: '/web/' });
    res.end();
    return;
  }

  let filePath = safeResolve(requestPath);
  if (!filePath) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  try {
    const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;

    if (stat && stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    } else if (!path.extname(filePath) && fs.existsSync(path.join(filePath, 'index.html'))) {
      filePath = path.join(filePath, 'index.html');
    }

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      sendText(res, 404, 'Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = contentTypes[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    sendText(res, 500, `Server error: ${err.message}`);
  }
});

server.listen(port, () => {
  console.log(`Serving ${rootDir} at http://localhost:${port}/`);
  console.log(`Open http://localhost:${port}/web/ for the web UI`);
});
