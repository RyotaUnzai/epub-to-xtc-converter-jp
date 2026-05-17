/**
 * Browser-based EPUB renderer for Japanese vertical layout.
 *
 * Uses the locally installed Chrome/Edge via Playwright Core to render EPUB
 * spine items with real browser CSS support, then captures each page as raw
 * pixel data for XTC encoding.
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const { chromium } = require('playwright-core');
const JSZip = require('jszip');
const sharp = require('sharp');

const REPO_ROOT = path.resolve(__dirname, '..');
const BUNDLED_ZEN_FONT = path.join(
    REPO_ROOT,
    'assets',
    'fonts',
    'Zen_Old_Mincho',
    'ZenOldMincho-Regular.ttf'
);

function isVerticalJapaneseLayout(settings) {
    return !!(settings && settings.layout && settings.layout.mode === 'vertical-jp');
}

function getAttribute(text, name) {
    const match = text.match(new RegExp(name + '\\s*=\\s*["\\\']([^"\\\']+)["\\\']', 'i'));
    return match ? match[1] : null;
}

function stripFragment(href) {
    return href ? href.split('#')[0].split('?')[0] : href;
}

function normalizePosixPath(baseDir, relPath) {
    const base = (baseDir || '').replace(/\\/g, '/');
    const rel = (relPath || '').replace(/\\/g, '/');
    return path.posix.normalize(path.posix.join(base, rel)).replace(/^\/+/, '');
}

async function readZipText(zip, relPath) {
    const file = zip.file(relPath);
    if (!file) return null;
    return await file.async('string');
}

async function parseEpubStructure(epubPath) {
    const epubBuffer = fs.readFileSync(epubPath);
    const zip = await JSZip.loadAsync(epubBuffer);

    let opfPath = null;
    const containerXml = await readZipText(zip, 'META-INF/container.xml');
    if (containerXml) {
        const rootfileMatch = containerXml.match(/<rootfile\b[^>]*full-path\s*=\s*["']([^"']+)["']/i);
        if (rootfileMatch) {
            opfPath = rootfileMatch[1];
        }
    }

    if (!opfPath) {
        const opfCandidates = Object.keys(zip.files).filter(name => /\.opf$/i.test(name));
        if (opfCandidates.length === 0) {
            throw new Error('EPUB package missing OPF file');
        }
        opfPath = opfCandidates[0];
    }

    const opfText = await readZipText(zip, opfPath);
    if (!opfText) {
        throw new Error(`Unable to read OPF: ${opfPath}`);
    }

    const manifest = new Map();
    opfText.replace(/<item\b([^>]+?)\/?>/gi, (_, attrs) => {
        const id = getAttribute(attrs, 'id');
        const href = getAttribute(attrs, 'href');
        const mediaType = getAttribute(attrs, 'media-type');
        if (id && href) {
            manifest.set(id, { id, href, mediaType });
        }
        return '';
    });

    const spine = [];
    opfText.replace(/<itemref\b([^>]+?)\/?>/gi, (_, attrs) => {
        const idref = getAttribute(attrs, 'idref');
        const item = idref ? manifest.get(idref) : null;
        if (!item) return '';
        if (!item.mediaType || /^(application\/xhtml\+xml|text\/html|application\/html\+xml)$/i.test(item.mediaType) || /\.(xhtml?|html?)$/i.test(item.href)) {
            spine.push({
                id: item.id,
                href: normalizePosixPath(path.posix.dirname(opfPath), stripFragment(item.href)),
                title: null
            });
        }
        return '';
    });

    const coverMetaId = opfText.match(/<meta\b[^>]*name=["']cover["'][^>]*content=["']([^"']+)["']/i)?.[1] || null;
    const coverMetaHref = coverMetaId && manifest.get(coverMetaId) ? manifest.get(coverMetaId).href : null;

    async function detectCoverChapter(spineItem) {
        if (!spineItem || !/\.(xhtml?|html?)$/i.test(spineItem.href || '')) {
            return null;
        }

        const text = await readZipText(zip, spineItem.href);
        if (!text) {
            return null;
        }

        if (!/<meta\b[^>]*name=["']calibre:cover["'][^>]*content=["']true["']/i.test(text) &&
            !/<meta\b[^>]*name=["']cover["'][^>]*content=["']true["']/i.test(text)) {
            return null;
        }

        const imageHref = text.match(/<image\b[^>]*(?:xlink:href|href)=["']([^"']+)["']/i)?.[1] ||
            text.match(/<img\b[^>]*src=["']([^"']+)["']/i)?.[1] ||
            coverMetaHref;

        return {
            kind: 'cover',
            coverImageHref: imageHref ? normalizePosixPath(path.posix.dirname(spineItem.href), imageHref) : null
        };
    }

    for (const spineItem of spine) {
        const coverInfo = await detectCoverChapter(spineItem);
        if (coverInfo) {
            spineItem.kind = coverInfo.kind;
            spineItem.coverImageHref = coverInfo.coverImageHref;
        } else {
            spineItem.kind = spineItem.kind || 'text';
        }
    }

    if (spine.length === 0) {
        throw new Error('EPUB spine is empty');
    }

    const titleMatch = opfText.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i);
    const creatorMatch = opfText.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i);
    const languageMatch = opfText.match(/<dc:language[^>]*>([\s\S]*?)<\/dc:language>/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
    const author = creatorMatch ? creatorMatch[1].replace(/<[^>]+>/g, '').trim() : '';
    const language = languageMatch ? languageMatch[1].replace(/<[^>]+>/g, '').trim() : '';

    return { zip, opfPath, spine, metadata: { title, author, language, coverImageHref: coverMetaHref || null } };
}

async function extractZipToDirectory(zip, targetDir) {
    const entries = Object.keys(zip.files);

    for (const entry of entries) {
        const file = zip.files[entry];
        const dest = path.join(targetDir, ...entry.split('/'));

        if (file.dir) {
            fs.mkdirSync(dest, { recursive: true });
            continue;
        }

        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const data = await file.async('nodebuffer');
        fs.writeFileSync(dest, data);
    }
}

function createStaticFileServer(rootDir) {
    const contentTypes = {
        '.css': 'text/css; charset=utf-8',
        '.html': 'text/html; charset=utf-8',
        '.htm': 'text/html; charset=utf-8',
        '.xhtml': 'application/xhtml+xml; charset=utf-8',
        '.xml': 'application/xml; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.ttf': 'font/ttf',
        '.otf': 'font/otf',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2'
    };

    function resolvePath(requestPath) {
        const decoded = decodeURIComponent(requestPath.split('?')[0]);
        const normalized = path.posix.normalize(decoded).replace(/^\/+/, '');
        const absolute = path.join(rootDir, ...normalized.split('/'));
        if (!absolute.startsWith(rootDir)) {
            return null;
        }
        return absolute;
    }

    const server = http.createServer((req, res) => {
        const requestPath = (new URL(req.url || '/', 'http://127.0.0.1')).pathname;
        const filePath = resolvePath(requestPath);
        if (!filePath) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Forbidden');
            return;
        }

        try {
            let resolved = filePath;
            if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
                resolved = path.join(resolved, 'index.html');
            }

            if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Not found');
                return;
            }

            const ext = path.extname(resolved).toLowerCase();
            const contentType = contentTypes[ext] || 'application/octet-stream';
            res.writeHead(200, {
                'Content-Type': contentType,
                'Cache-Control': 'no-store'
            });
            fs.createReadStream(resolved).pipe(res);
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`Server error: ${err.message}`);
        }
    });

    return new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            resolve({
                server,
                baseUrl: `http://127.0.0.1:${address.port}`,
                close: () => new Promise((closeResolve) => server.close(closeResolve))
            });
        });
        server.on('error', reject);
    });
}

function escapeCssString(text) {
    return String(text || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function buildBrowserStyleSheet(settings, fontFamilyName, fontDataUrl, mode = 'text') {
    if (mode === 'cover') {
        return [
            'html, body {',
            '  margin: 0 !important;',
            '  padding: 0 !important;',
            '  width: 100% !important;',
            '  height: 100% !important;',
            '  overflow: hidden !important;',
            '  background: #fff !important;',
            '  color: #000 !important;',
            '}',
            'body {',
            '  position: relative !important;',
            '  box-sizing: border-box !important;',
            '  overflow: hidden !important;',
            '  background: #fff !important;',
            '  writing-mode: horizontal-tb !important;',
            '  -webkit-writing-mode: horizontal-tb !important;',
            '  -epub-writing-mode: horizontal-tb !important;',
            '  text-orientation: mixed !important;',
            '  -webkit-text-orientation: mixed !important;',
            '  -epub-text-orientation: mixed !important;',
            '  direction: ltr !important;',
            '  unicode-bidi: plaintext !important;',
            '}',
            '#xtc-page {',
            '  position: relative !important;',
            '  width: 100% !important;',
            '  height: 100% !important;',
            '  overflow: hidden !important;',
            '  background: #fff !important;',
            '}',
            '#xtc-viewport {',
            '  position: absolute !important;',
            '  inset: 0 !important;',
            '  overflow: hidden !important;',
            '  display: flex !important;',
            '  align-items: center !important;',
            '  justify-content: center !important;',
            '  background: #fff !important;',
            '  box-sizing: border-box !important;',
            '}',
            '#xtc-content {',
            '  position: relative !important;',
            '  width: 100% !important;',
            '  height: 100% !important;',
            '  overflow: hidden !important;',
            '  display: flex !important;',
            '  align-items: center !important;',
            '  justify-content: center !important;',
            '  transform: none !important;',
            '  transform-origin: center center !important;',
            '  box-sizing: border-box !important;',
            '}',
            '#xtc-content img, #xtc-content svg, #xtc-content video, #xtc-content canvas {',
            '  max-width: 100% !important;',
            '  max-height: 100% !important;',
            '  width: auto !important;',
            '  height: auto !important;',
            '  object-fit: contain !important;',
            '  display: block !important;',
            '}',
            '#xtc-content > div {',
            '  width: 100% !important;',
            '  height: 100% !important;',
            '  display: flex !important;',
            '  align-items: center !important;',
            '  justify-content: center !important;',
            '}'
        ].join('\n');
    }

    const fontSize = Number(settings?.font?.size || 34);
    const fontWeight = Number(settings?.font?.weight || 400);
    const lineHeight = Math.min(Number(settings?.lineHeight || 120) / 100, 1.08);
    const bodyFontFamily = fontFamilyName || 'serif';

    const fontFace = fontDataUrl
        ? [
            '@font-face {',
            `  font-family: '${escapeCssString(bodyFontFamily)}';`,
            `  src: url('${fontDataUrl}') format('truetype');`,
            '  font-style: normal;',
            '  font-weight: 400;',
            '}'
        ].join('\n')
        : '';

    return [
        fontFace,
        'html, body {',
        '  margin: 0 !important;',
        '  padding: 0 !important;',
        '  width: 100% !important;',
        '  height: 100% !important;',
        '  overflow: hidden !important;',
        '  background: #fff !important;',
        '  color: #000 !important;',
        '}',
        'body {',
        '  position: relative !important;',
        '  box-sizing: border-box !important;',
        '  overflow: hidden !important;',
        '  background: #fff !important;',
        '}',
        '#xtc-page {',
        '  position: relative !important;',
        '  width: 100% !important;',
        '  height: 100% !important;',
        '  overflow: hidden !important;',
        '  background: #fff !important;',
        '}',
        '#xtc-viewport {',
        '  position: absolute !important;',
        '  overflow: hidden !important;',
        '  background: #fff !important;',
        '  box-sizing: border-box !important;',
        '}',
        '#xtc-content {',
        '  position: absolute !important;',
        '  top: 0 !important;',
        '  right: 0 !important;',
        '  height: 100% !important;',
        '  min-height: 100% !important;',
        '  width: max-content !important;',
        '  max-width: none !important;',
        '  overflow: visible !important;',
        '  transform-origin: top right !important;',
        '  writing-mode: vertical-rl !important;',
        '  -webkit-writing-mode: vertical-rl !important;',
        '  -epub-writing-mode: vertical-rl !important;',
        '  text-orientation: mixed !important;',
        '  -webkit-text-orientation: mixed !important;',
        '  -epub-text-orientation: mixed !important;',
        '  direction: rtl !important;',
        '  unicode-bidi: plaintext !important;',
        '  font-family: \'' + escapeCssString(bodyFontFamily) + '\' !important;',
        `  font-size: ${fontSize}px !important;`,
        `  font-weight: ${fontWeight} !important;`,
        `  line-height: ${lineHeight} !important;`,
        '  box-sizing: border-box !important;',
        '  padding: 0 !important;',
        '  text-align: start !important;',
        '  text-justify: none !important;',
        '  line-break: strict !important;',
        '  word-break: normal !important;',
        '  letter-spacing: 0 !important;',
        '  word-spacing: 0 !important;',
        '  hyphens: none !important;',
        '  -webkit-hyphens: none !important;',
        '  transform: translateX(0) !important;',
        '  will-change: transform;',
        '}',
        '#xtc-content * {',
        '  writing-mode: inherit !important;',
        '  -webkit-writing-mode: inherit !important;',
        '  -epub-writing-mode: inherit !important;',
        '  text-orientation: inherit !important;',
        '  -webkit-text-orientation: inherit !important;',
        '  -epub-text-orientation: inherit !important;',
        '  direction: inherit !important;',
        '  unicode-bidi: inherit !important;',
        '}',
        '#xtc-content p { text-indent: 0 !important; margin: 0.25em 0 !important; }',
        '#xtc-content ruby { ruby-position: over; ruby-align: center; ruby-merge: separate; line-height: 1 !important; }',
        '#xtc-content rt, #xtc-content rp {',
        '  writing-mode: vertical-rl !important;',
        '  -webkit-writing-mode: vertical-rl !important;',
        '  -epub-writing-mode: vertical-rl !important;',
        '  text-orientation: upright !important;',
        '  -webkit-text-orientation: upright !important;',
        '  -epub-text-orientation: upright !important;',
        '  font-size: 0.5em !important;',
        '  line-height: 1 !important;',
        '  margin: 0 !important;',
        '  padding: 0 !important;',
        '  letter-spacing: 0 !important;',
        '  white-space: nowrap !important;',
        '  transform: none !important;',
        '  rotate: none !important;',
        '}',
        '#xtc-content img, #xtc-content svg, #xtc-content video, #xtc-content canvas { max-width: 100% !important; height: auto !important; }'
    ].filter(Boolean).join('\n');
}

function getVerticalBodyPadding(settings) {
    const fontSize = Number(settings?.font?.size || 34);
    const margins = settings?.margins || { top: 16, right: 16, bottom: 16, left: 16 };
    const safeInset = Math.max(8, Math.round(fontSize * 0.18));
    const rubyInset = Math.max(6, Math.round(fontSize * 0.18));
    const blockEndReserve = Math.max(8, Math.round(fontSize * 0.25));
    return {
        top: Number(margins.top || 0) + safeInset + rubyInset,
        right: Number(margins.right || 0) + safeInset,
        bottom: Number(margins.bottom || 0) + safeInset,
        left: Number(margins.left || 0) + safeInset + rubyInset + blockEndReserve
    };
}

function getVerticalClipInset(settings) {
    const fontSize = Number(settings?.font?.size || 34);
    return Math.max(12, Math.round(fontSize * 0.65));
}

function getVerticalPageStride(viewportWidth, settings) {
    const fontSize = Number(settings?.font?.size || 34);
    const lineHeight = Math.min(Number(settings?.lineHeight || 120) / 100, 1.08);
    const lineAdvance = Math.max(fontSize, Math.round(fontSize * lineHeight));
    const rubyReserve = Math.max(8, Math.round(fontSize * 0.5));
    const boundaryReserve = Math.max(lineAdvance * 3, lineAdvance + rubyReserve * 2);
    return Math.max(1, Math.round(viewportWidth - boundaryReserve));
}

function getVerticalLineAdvance(settings) {
    const fontSize = Number(settings?.font?.size || 34);
    const lineHeight = Math.min(Number(settings?.lineHeight || 120) / 100, 1.08);
    return Math.max(fontSize, Math.round(fontSize * lineHeight));
}

function buildVerticalPageOffsets(columns, viewportWidth, contentWidth, pageWidth) {
    const maxOffset = Math.max(0, contentWidth - viewportWidth);
    const stride = Math.max(1, Math.round(pageWidth * 0.9));

    if (maxOffset <= 0) {
        return [0];
    }

    const offsets = [0];
    for (let offset = stride; offset < maxOffset; offset += stride) {
        offsets.push(offset);
    }

    if (offsets[offsets.length - 1] !== maxOffset) {
        offsets.push(maxOffset);
    }

    return offsets;
}

function isVisibleChapterCover(chapter) {
    return !!chapter && chapter.kind === 'cover';
}

function buildColumnMeasurementScript() {
    return () => {
        const viewport = document.getElementById('xtc-viewport');
        const content = document.getElementById('xtc-content');
        const viewportRect = viewport ? viewport.getBoundingClientRect() : { right: window.innerWidth };
        const clipInset = viewport ? parseFloat(viewport.dataset.clipInset || '0') || 0 : 0;
        const anchorRight = viewportRect.right - clipInset;
        const clientWidth = viewport ? Math.max(1, viewport.clientWidth - clipInset * 2) : window.innerWidth;
        const clientHeight = viewport ? viewport.clientHeight : window.innerHeight;
        const computedStyle = getComputedStyle(content || document.body);
        const fontSize = parseFloat(computedStyle.fontSize || '24') || 24;
        const columnThreshold = Math.max(8, Math.round(fontSize * 0.45));
        let minX = Infinity;
        let maxX = -Infinity;
        const columns = [];

        const maxRectWidth = Math.max(1, clientWidth * 1.5);
        const maxRectHeight = Math.max(1, clientHeight * 1.5);

        function addRect(rect) {
            if (!rect || rect.width <= 0 || rect.height <= 0) {
                return;
            }

            if (rect.width > maxRectWidth || rect.height > maxRectHeight) {
                return;
            }

            minX = Math.min(minX, rect.left);
            maxX = Math.max(maxX, rect.right);

            const normalized = {
                left: anchorRight - rect.right,
                right: anchorRight - rect.left
            };
            let column = columns.find(item => !(normalized.right < item.left - columnThreshold || normalized.left > item.right + columnThreshold));
            if (!column) {
                column = { left: normalized.left, right: normalized.right, count: 0 };
                columns.push(column);
            }
            column.left = Math.min(column.left, normalized.left);
            column.right = Math.max(column.right, normalized.right);
            column.count += 1;
        }

        if (content) {
            const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
            const range = document.createRange();
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                const text = node.nodeValue || '';
                for (let i = 0; i < text.length; i++) {
                    if (!text[i] || /\s/.test(text[i])) {
                        continue;
                    }
                    range.setStart(node, i);
                    range.setEnd(node, i + 1);
                    for (const rect of range.getClientRects()) {
                        addRect(rect);
                    }
                }
            }
            range.detach();

            for (const el of Array.from(content.querySelectorAll('img, svg, canvas, video'))) {
                addRect(el.getBoundingClientRect());
            }
        }

        columns.sort((a, b) => a.left - b.left);
        const maxColumnWidth = Math.max(1, clientWidth * 1.5);
        const filteredColumns = columns.filter(column => (
            Number.isFinite(column.left) &&
            Number.isFinite(column.right) &&
            column.right > column.left &&
            column.right - column.left <= maxColumnWidth
        ));
        const resultColumns = filteredColumns.length > 0 ? filteredColumns : columns;
        const contentWidth = Number.isFinite(minX)
            ? Math.max(1, Math.ceil(anchorRight - minX))
            : Math.max(1, content ? content.scrollWidth : clientWidth);
        const scrollHeight = content ? content.scrollHeight : clientHeight;
        const title = document.title || '';

        return { scrollWidth: contentWidth, clientWidth, scrollHeight, clientHeight, title, columns: resultColumns };
    };
}

async function scoreVerticalPageEdges(pngBuffer, settings, padding) {
    const raw = await sharp(pngBuffer)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const width = raw.info.width;
    const height = raw.info.height;
    const data = raw.data;
    const edgeBandX = Math.max(4, Math.round(Number(settings?.font?.size || 34) * 0.35));
    const edgeBandY = Math.max(4, Math.round(Number(settings?.font?.size || 34) * 0.35));

    function isInk(x, y) {
        const i = (y * width + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];
        return !(r > 245 && g > 245 && b > 245 && a > 0);
    }

    let leftInk = 0;
    let rightInk = 0;
    let topInk = 0;
    let bottomInk = 0;
    let pageLeftInk = 0;
    let pageRightInk = 0;
    let pageTopInk = 0;
    let pageBottomInk = 0;
    const leftStart = Math.max(0, Math.min(width - 1, Math.round(padding.left || 0)));
    const topStart = Math.max(0, Math.min(height - 1, Math.round(padding.top || 0)));
    const rightStart = Math.max(0, Math.min(width - 1, width - Math.max(1, Math.round(padding.right || 0)) - 1));
    const bottomStart = Math.max(0, Math.min(height - 1, height - Math.max(1, Math.round(padding.bottom || 0)) - 1));

    for (let y = 0; y < height; y++) {
        for (let x = leftStart; x < Math.min(width, leftStart + edgeBandX); x++) {
            if (isInk(x, y)) leftInk++;
        }
        for (let x = Math.max(0, rightStart - edgeBandX + 1); x <= rightStart; x++) {
            if (isInk(x, y)) rightInk++;
        }
    }
    for (let x = 0; x < width; x++) {
        for (let y = topStart; y < Math.min(height, topStart + edgeBandY); y++) {
            if (isInk(x, y)) topInk++;
        }
        for (let y = Math.max(0, bottomStart - edgeBandY + 1); y <= bottomStart; y++) {
            if (isInk(x, y)) bottomInk++;
        }
    }

    return {
        score: leftInk * 16 + rightInk * 16 + topInk * 8 + bottomInk * 8,
        edgeInk: leftInk + rightInk + topInk + bottomInk
    };
}

async function loadBrowserFontDataUrl(settings) {
    const fontPath = settings?.font?.path || BUNDLED_ZEN_FONT;
    if (!fontPath || !fs.existsSync(fontPath)) {
        return null;
    }
    const ext = path.extname(fontPath).toLowerCase();
    const mime = ext === '.otf' ? 'font/otf' : 'font/ttf';
    const fontData = fs.readFileSync(fontPath).toString('base64');
    return `data:${mime};base64,${fontData}`;
}

function resolveBrowserExecutable() {
    const candidates = [
        process.env.CHROME_PATH,
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return null;
}

class VerticalBrowserSession {
    constructor(epubPath, settings) {
        this.epubPath = epubPath;
        this.settings = settings;
        this.structure = null;
        this.tempDir = null;
        this.serverHandle = null;
        this.browser = null;
        this.page = null;
        this.textStylesheet = '';
        this.coverStylesheet = '';
        this.verticalPadding = getVerticalBodyPadding(settings);
        this.chapterMeta = [];
        this.info = { title: '', author: '', authors: '', language: '' };
        this.pageCount = 0;
        this.toc = [];
        this.currentChapterIndex = -1;
        this.currentChapterUrl = null;
    }

    async init(progressCallback) {
        if (!isVerticalJapaneseLayout(this.settings)) {
            throw new Error('Browser renderer is only used for vertical Japanese layout');
        }

        const emitProgress = (current, total, meta = {}) => {
            if (typeof progressCallback === 'function') {
                progressCallback(current, total, meta);
            }
        };

        emitProgress(0, 0, { stage: 'init', message: 'Opening EPUB...' });
        this.structure = await parseEpubStructure(this.epubPath);
        emitProgress(0, 0, { stage: 'init', message: 'Extracting EPUB...' });
        this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epub-vertical-'));
        const fontDataUrl = await loadBrowserFontDataUrl(this.settings);
        const fontFamilyName = path.basename(this.settings?.font?.path || BUNDLED_ZEN_FONT, path.extname(this.settings?.font?.path || BUNDLED_ZEN_FONT)) || 'BrowserEpubFont';
        const browserExecutable = resolveBrowserExecutable();

        if (!browserExecutable) {
            throw new Error('No Chrome/Edge executable found. Set CHROME_PATH or install Chrome.');
        }

        emitProgress(0, 0, { stage: 'init', message: 'Launching browser...' });
        await extractZipToDirectory(this.structure.zip, this.tempDir);
        this.serverHandle = await createStaticFileServer(this.tempDir);
        this.browser = await chromium.launch({
            headless: true,
            executablePath: browserExecutable,
            args: ['--no-sandbox', '--disable-dev-shm-usage']
        });
        this.page = await this.browser.newPage({
            viewport: {
                width: Number(this.settings?.width || 480),
                height: Number(this.settings?.height || 800)
            },
            deviceScaleFactor: 1
        });

        this.textStylesheet = buildBrowserStyleSheet(this.settings, fontFamilyName, fontDataUrl, 'text');
        this.coverStylesheet = buildBrowserStyleSheet(this.settings, fontFamilyName, fontDataUrl, 'cover');
        emitProgress(0, 0, { stage: 'measure', message: 'Measuring chapter layout...' });
        await this._measureChapters((current, total, meta = {}) => {
            emitProgress(current, total, meta);
        });
        return {
            info: this.info,
            toc: this.toc,
            pageCount: this.pageCount
        };
    }

    async _loadChapter(chapter) {
        if (!this.page || !chapter) {
            throw new Error('Vertical browser session not initialized');
        }

        if (this.currentChapterUrl !== chapter.url) {
            if (chapter.kind === 'cover') {
                const coverHref = chapter.coverImageHref || chapter.url;
                const coverSrc = new URL(coverHref, chapter.url).toString();
                const coverHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="xtc-cover-root"><img id="xtc-cover-image" src="${coverSrc}" alt="cover"></div></body></html>`;
                await this.page.setContent(coverHtml, { waitUntil: 'load' });
                await this.page.waitForLoadState('networkidle').catch(() => {});
                await this.page.addStyleTag({ content: this.coverStylesheet });
            } else {
                await this.page.goto(chapter.url, { waitUntil: 'load' });
                await this.page.waitForLoadState('networkidle').catch(() => {});
                await this.page.addStyleTag({ content: this.textStylesheet });
            }
            this.currentChapterUrl = chapter.url;
            this.currentChapterIndex = this.chapterMeta.indexOf(chapter);
        }

        await this.page.evaluate(({ padding, width, height, clipInset, kind }) => {
            const root = document.documentElement;
            const body = document.body;
            if (root) {
                root.dir = kind === 'cover' ? 'ltr' : 'rtl';
                root.style.scrollBehavior = 'auto';
                root.style.setProperty('margin', '0', 'important');
                root.style.setProperty('padding', '0', 'important');
                root.style.setProperty('overflow', 'hidden', 'important');
                root.style.setProperty('box-sizing', 'border-box', 'important');
                root.style.setProperty('width', `${width}px`, 'important');
                root.style.setProperty('height', `${height}px`, 'important');
            }
            if (body) {
                body.dir = kind === 'cover' ? 'ltr' : 'rtl';
                body.style.scrollBehavior = 'auto';
                body.scrollLeft = 0;
                body.scrollTop = 0;
                body.style.setProperty('margin', '0', 'important');
                body.style.setProperty('padding', '0', 'important');
                body.style.setProperty('box-sizing', 'border-box', 'important');
                body.style.setProperty('overflow', 'hidden', 'important');
                body.style.setProperty('width', `${width}px`, 'important');
                body.style.setProperty('height', `${height}px`, 'important');
                body.style.setProperty('position', 'relative', 'important');

                let pageBox = document.getElementById('xtc-page');
                let viewport = document.getElementById('xtc-viewport');
                let content = document.getElementById('xtc-content');
                if (!pageBox || !viewport || !content) {
                    pageBox = document.createElement('div');
                    pageBox.id = 'xtc-page';
                    viewport = document.createElement('div');
                    viewport.id = 'xtc-viewport';
                    content = document.createElement('div');
                    content.id = 'xtc-content';

                    while (body.firstChild) {
                        content.appendChild(body.firstChild);
                    }

                    viewport.appendChild(content);
                    pageBox.appendChild(viewport);
                    body.appendChild(pageBox);
                }

                pageBox.style.setProperty('width', `${width}px`, 'important');
                pageBox.style.setProperty('height', `${height}px`, 'important');
                pageBox.style.setProperty('overflow', 'hidden', 'important');

                if (kind === 'cover') {
                    viewport.style.setProperty('inset', '0', 'important');
                    viewport.style.setProperty('overflow', 'hidden', 'important');
                    viewport.style.setProperty('display', 'flex', 'important');
                    viewport.style.setProperty('align-items', 'center', 'important');
                    viewport.style.setProperty('justify-content', 'center', 'important');
                    viewport.removeAttribute('data-clip-inset');
                    content.style.setProperty('height', '100%', 'important');
                    content.style.setProperty('min-height', '100%', 'important');
                    content.style.setProperty('width', '100%', 'important');
                    content.style.setProperty('right', '0', 'important');
                    content.style.setProperty('display', 'flex', 'important');
                    content.style.setProperty('align-items', 'center', 'important');
                    content.style.setProperty('justify-content', 'center', 'important');
                    content.style.setProperty('transform', 'none', 'important');
                    content.style.setProperty('transform-origin', 'center center', 'important');
                } else {
                    viewport.style.setProperty('top', `${padding.top}px`, 'important');
                    viewport.style.setProperty('right', `${padding.right}px`, 'important');
                    viewport.style.setProperty('bottom', `${padding.bottom}px`, 'important');
                    viewport.style.setProperty('left', `${padding.left}px`, 'important');
                    viewport.style.setProperty('overflow', 'hidden', 'important');
                    viewport.dataset.clipInset = String(clipInset);

                    const viewportWidth = Math.max(1, width - padding.left - padding.right);
                    const viewportHeight = Math.max(1, height - padding.top - padding.bottom);
                    const layoutWidth = Math.max(1, viewportWidth - clipInset * 2);
                    content.style.setProperty('height', `${viewportHeight}px`, 'important');
                    content.style.setProperty('min-height', `${viewportHeight}px`, 'important');
                    content.style.setProperty('right', `${clipInset}px`, 'important');
                    content.style.setProperty('width', `${layoutWidth}px`, 'important');
                    content.style.setProperty('transform-origin', 'top right', 'important');
                    content.style.setProperty('transform', 'translateX(0px)', 'important');
                }
            }
        }, {
            padding: this.verticalPadding,
            width: Number(this.settings?.width || 480),
            height: Number(this.settings?.height || 800),
            clipInset: getVerticalClipInset(this.settings),
            kind: chapter.kind || 'text'
        });
        await this.page.evaluate(async () => {
            if (document.fonts && document.fonts.ready) {
                try { await document.fonts.ready; } catch {}
            }
        });
    }

    async _measureChapter(chapter) {
        await this._loadChapter(chapter);
        return await this.page.evaluate(buildColumnMeasurementScript());
    }

    async _measureChapters(progressCallback) {
        const chapterMeta = [];
        let totalPages = 0;
        for (let i = 0; i < this.structure.spine.length; i++) {
            const item = this.structure.spine[i];
            const chapterUrl = `${this.serverHandle.baseUrl}/${item.href.split('/').map(encodeURIComponent).join('/')}`;
            const chapter = {
                href: item.href,
                title: item.title || '',
                pageStart: totalPages,
                pageCount: 0,
                url: chapterUrl,
                kind: item.kind || 'text',
                coverImageHref: item.coverImageHref || this.structure.metadata.coverImageHref || null
            };

            if (isVisibleChapterCover(chapter)) {
                const viewportWidth = Math.max(1, Number(this.settings?.width || 480) - this.verticalPadding.left - this.verticalPadding.right);
                const viewportHeight = Math.max(1, Number(this.settings?.height || 800) - this.verticalPadding.top - this.verticalPadding.bottom);
                chapter.title = 'Cover';
                chapter.pageCount = 1;
                chapter.contentWidth = viewportWidth;
                chapter.viewportWidth = viewportWidth;
                chapter.pageWidth = viewportWidth;
                chapter.pageOffsets = [0];
            } else {
                const metrics = await this._measureChapter(chapter);
                const viewportWidth = Math.max(1, metrics.clientWidth);
                const pageWidth = getVerticalPageStride(viewportWidth, this.settings);
                const pageOffsets = buildVerticalPageOffsets(metrics.columns, viewportWidth, metrics.scrollWidth, pageWidth);
                chapter.title = (metrics.title && metrics.title.trim()) || path.basename(item.href, path.extname(item.href)) || `Chapter ${i + 1}`;
                chapter.pageCount = pageOffsets.length;
                chapter.contentWidth = metrics.scrollWidth;
                chapter.viewportWidth = viewportWidth;
                chapter.pageWidth = pageWidth;
                chapter.pageOffsets = pageOffsets;
            }
            chapterMeta.push(chapter);
            totalPages += chapter.pageCount;
            if (typeof progressCallback === 'function') {
                progressCallback(i + 1, this.structure.spine.length, {
                    stage: 'measure',
                    message: `Measuring chapter ${i + 1} / ${this.structure.spine.length}`
                });
            }
        }
        this.chapterMeta = chapterMeta;
        this.pageCount = totalPages;
        this.toc = chapterMeta.map(item => ({ title: item.title, page: item.pageStart }));
        this.info = this.structure.metadata;
    }

    _chapterForPage(pageIndex) {
        for (let i = this.chapterMeta.length - 1; i >= 0; i--) {
            const chapter = this.chapterMeta[i];
            if (pageIndex >= chapter.pageStart) {
                return chapter;
            }
        }
        return this.chapterMeta[0] || null;
    }

    async renderPage(pageIndex) {
        const chapter = this._chapterForPage(pageIndex);
        if (!chapter) {
            throw new Error('No chapter available for page render');
        }

        await this._loadChapter(chapter);

        if (isVisibleChapterCover(chapter)) {
            await this.page.waitForTimeout(50);
            return await this.page.screenshot({ type: 'png' });
        }

        const pageInChapter = Math.max(0, pageIndex - chapter.pageStart);
        const viewportWidth = Math.max(1, chapter.viewportWidth || Number(this.settings?.width || 480));
        const pageWidth = Math.max(1, chapter.pageWidth || getVerticalPageStride(viewportWidth, this.settings));
        const maxOffset = Math.max(0, (chapter.contentWidth || viewportWidth) - viewportWidth);
        let offset = Array.isArray(chapter.pageOffsets) && Number.isFinite(chapter.pageOffsets[pageInChapter])
            ? chapter.pageOffsets[pageInChapter]
            : pageInChapter * pageWidth;
        offset = Math.min(offset, maxOffset);

        const lineAdvance = getVerticalLineAdvance(this.settings);
        let bestScore = Infinity;
        let bestOffset = offset;
        let bestDistance = Infinity;
        const candidateOffsets = [];
        for (let step = 0; step <= 3; step++) {
            const delta = step * lineAdvance;
            for (const candidateOffset of [offset - delta, offset + delta]) {
                const clamped = Math.max(0, Math.min(maxOffset, Math.round(candidateOffset)));
                if (!candidateOffsets.includes(clamped)) {
                    candidateOffsets.push(clamped);
                }
            }
        }

        for (let i = 0; i < candidateOffsets.length; i++) {
            await this.page.evaluate((x) => {
                const content = document.getElementById('xtc-content');
                if (content) {
                    content.style.setProperty('transform', `translateX(${x}px)`, 'important');
                }
            }, candidateOffsets[i]);
            await this.page.waitForTimeout(i === 0 ? 12 : 4);
            const viewportCandidate = await this.page.locator('#xtc-viewport').screenshot({ type: 'png' });
            const edgeScore = await scoreVerticalPageEdges(viewportCandidate, this.settings, { top: 0, right: 0, bottom: 0, left: 0 });
            const candidateDistance = Math.abs(candidateOffsets[i] - offset);
            if (candidateDistance < bestDistance || (candidateDistance === bestDistance && edgeScore.score < bestScore)) {
                bestScore = edgeScore.score;
                bestOffset = candidateOffsets[i];
                bestDistance = candidateDistance;
            }
            // Continue scanning all candidates even if a perfect edge score is found.
            // Use proximity to the measured offset to break ties between clean candidates.
        }

        await this.page.evaluate((x) => {
            const content = document.getElementById('xtc-content');
            if (content) {
                content.style.setProperty('transform', `translateX(${x}px)`, 'important');
            }
        }, bestOffset);
        await this.page.waitForTimeout(20);
        return await this.page.screenshot({ type: 'png' });
    }

    async renderPageRaw(pageIndex) {
        const pngBuffer = await this.renderPage(pageIndex);
        const raw = await sharp(pngBuffer)
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        return {
            data: new Uint8ClampedArray(raw.data),
            width: raw.info.width,
            height: raw.info.height
        };
    }

    async close() {
        if (this.page) {
            await this.page.close().catch(() => {});
            this.page = null;
        }
        if (this.browser) {
            await this.browser.close().catch(() => {});
            this.browser = null;
        }
        if (this.serverHandle) {
            await this.serverHandle.close().catch(() => {});
            this.serverHandle = null;
        }
        if (this.tempDir) {
            fs.rmSync(this.tempDir, { recursive: true, force: true });
            this.tempDir = null;
        }
    }
}

async function openVerticalBrowserSession(epubPath, settings) {
    const session = new VerticalBrowserSession(epubPath, settings);
    return await session.init();
}

async function renderVerticalPages(epubPath, settings, progressCallback) {
    const session = new VerticalBrowserSession(epubPath, settings);
    try {
        await session.init(progressCallback);

        const pages = [];
        for (let i = 0; i < session.pageCount; i++) {
            const renderStart = performance.now();
            const raw = await session.renderPageRaw(i);
            pages.push(raw);
            if (progressCallback) {
                progressCallback(i + 1, session.pageCount, {
                    stage: 'render',
                    pageIndex: i,
                    pageTimeMs: Math.max(0, Math.round(performance.now() - renderStart)),
                    message: `Rendering page ${i + 1} / ${session.pageCount}`
                });
            }
        }

        return {
            pages,
            toc: session.toc,
            info: session.info,
            pageCount: session.pageCount
        };
    } finally {
        await session.close();
    }
}

module.exports = {
    isVerticalJapaneseLayout,
    openVerticalBrowserSession,
    renderVerticalPages,
    VerticalBrowserSession
};
