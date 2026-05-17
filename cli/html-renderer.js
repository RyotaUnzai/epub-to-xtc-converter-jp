/**
 * Browser-based HTML renderer for vertical Japanese layout.
 *
 * This path is used for standalone HTML/XHTML sources. It decodes the source
 * document, normalizes it to UTF-8, applies a vertical print stylesheet, asks
 * Chromium to paginate it into a PDF, and then rasterizes each PDF page into
 * raw pixel data for XTC encoding.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { performance } = require('perf_hooks');
const { chromium } = require('playwright-core');
const sharp = require('sharp');
const { Path2D, DOMMatrix, ImageData, Canvas } = require('skia-canvas');

const PREFERRED_ZEN_FONT_PATH = 'J:\\download\\Zen_Old_Mincho\\ZenOldMincho-Regular.ttf';
const BUNDLED_ZEN_FONT_PATH = path.join(
    __dirname,
    '..',
    'assets',
    'fonts',
    'Zen_Old_Mincho',
    'ZenOldMincho-Regular.ttf'
);

let pdfjsModulePromise = null;

function isHtmlDocumentInput(inputPath) {
    return /\.(html|htm|xhtml)$/i.test(inputPath || '');
}

function getDefaultBrowserExecutable() {
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

function normalizeCharsetLabel(label) {
    const value = String(label || '').trim().toLowerCase();
    switch (value) {
        case 'utf8':
        case 'utf-8':
            return 'utf-8';
        case 'shift_jis':
        case 'shift-jis':
        case 'sjis':
        case 'ms932':
        case 'cp932':
        case 'windows-31j':
            return 'shift_jis';
        case 'euc-jp':
        case 'eucjp':
            return 'euc-jp';
        case 'iso-2022-jp':
        case 'iso2022-jp':
            return 'iso-2022-jp';
        default:
            return value || 'utf-8';
    }
}

function detectCharsetFromHtmlBytes(buffer) {
    const head = Buffer.from(buffer.slice(0, 4096)).toString('latin1');
    const xmlMatch = head.match(/<\?xml\b[^>]*encoding\s*=\s*["']([^"']+)["']/i);
    if (xmlMatch) {
        return normalizeCharsetLabel(xmlMatch[1]);
    }

    const metaCharsetMatch = head.match(/<meta\b[^>]*charset\s*=\s*["']?([^\s"'>;]+)["']?/i);
    if (metaCharsetMatch) {
        return normalizeCharsetLabel(metaCharsetMatch[1]);
    }

    const httpEquivMatch = head.match(/<meta\b[^>]*http-equiv\s*=\s*["']content-type["'][^>]*content\s*=\s*["'][^"']*charset=([^"'\s;>]+)[^"']*["']/i);
    if (httpEquivMatch) {
        return normalizeCharsetLabel(httpEquivMatch[1]);
    }

    return 'utf-8';
}

function decodeHtmlBuffer(buffer) {
    const charset = detectCharsetFromHtmlBytes(buffer);
    const candidates = [charset, 'utf-8', 'shift_jis', 'euc-jp', 'iso-2022-jp'];
    const tried = new Set();

    for (const candidate of candidates) {
        const label = normalizeCharsetLabel(candidate);
        if (tried.has(label)) {
            continue;
        }
        tried.add(label);

        try {
            return {
                text: new TextDecoder(label).decode(buffer),
                charset: label
            };
        } catch (err) {
            // Try the next charset candidate.
        }
    }

    return {
        text: new TextDecoder('utf-8').decode(buffer),
        charset: 'utf-8'
    };
}

function stripXmlDeclaration(html) {
    return html.replace(/^\s*<\?xml[\s\S]*?\?>\s*/i, '');
}

function replaceCharsetMeta(html) {
    let updated = html.replace(
        /<meta\b[^>]*http-equiv\s*=\s*["']content-type["'][^>]*charset=[^"'\s>]+[^>]*\/?>/i,
        '<meta charset="utf-8" />'
    );

    if (!/<meta\b[^>]*charset\s*=/i.test(updated)) {
        updated = updated.replace(/<head\b([^>]*)>/i, '<head$1>\n<meta charset="utf-8" />');
    }

    return updated;
}

function injectBaseHref(html, sourceDir) {
    const resolvedSourceDir = path.resolve(sourceDir || process.cwd());
    const baseHref = pathToFileURL(resolvedSourceDir).href.replace(/\/?$/, '/');
    const baseTag = `<base href="${baseHref}">`;

    if (/<base\b/i.test(html)) {
        return html;
    }

    return html.replace(/<head\b([^>]*)>/i, `<head$1>\n${baseTag}`);
}

function stripScriptTags(html) {
    return html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
}

function replaceAozoraPageBreaks(html) {
    return html.replace(
        /<span\b[^>]*class=["'][^"']*\bnotes\b[^"']*["'][^>]*>\s*［＃改頁］\s*<\/span>\s*(?:<br\s*\/?>\s*)*/gi,
        '<div class="xtc-page-break" aria-hidden="true"></div>'
    );
}

function buildVerticalPrintCss(settings) {
    const width = Number(settings?.width || 528);
    const height = Number(settings?.height || 792);
    const margins = settings?.margins || { top: 16, right: 16, bottom: 16, left: 16 };
    const fontSize = Number(settings?.font?.size || 24);
    const fontWeight = Number(settings?.font?.weight || 400);
    const lineHeight = Math.max(1, Number(settings?.lineHeight || 120) / 100);
    const textAlignSetting = String(settings?.textAlign || 'justify').toLowerCase();
    const textAlign = textAlignSetting === 'left'
        ? 'start'
        : textAlignSetting === 'right'
            ? 'end'
            : textAlignSetting === 'center'
                ? 'center'
                : 'justify';
    const fontPath = fs.existsSync(PREFERRED_ZEN_FONT_PATH)
        ? PREFERRED_ZEN_FONT_PATH
        : (settings?.font?.path && fs.existsSync(settings.font.path) ? settings.font.path : (fs.existsSync(BUNDLED_ZEN_FONT_PATH) ? BUNDLED_ZEN_FONT_PATH : null));
    const safeInset = Math.max(8, Math.round(fontSize * 0.18));
    const rubyInset = Math.max(6, Math.round(fontSize * 0.18));
    const blockEndReserve = Math.max(8, Math.round(fontSize * 0.25));
    const padTop = Number(margins.top || 0) + safeInset + rubyInset;
    const padRight = Number(margins.right || 0) + safeInset;
    const padBottom = Number(margins.bottom || 0) + safeInset;
    const padLeft = Number(margins.left || 0) + safeInset + rubyInset + blockEndReserve;

    const fontFace = fontPath
        ? [
            '  @font-face {',
            '    font-family: "ZenOldMincho";',
            `    src: url("${pathToFileURL(fontPath).href}") format("truetype");`,
            '    font-style: normal;',
            '    font-weight: 400;',
            '  }'
        ].join('\n')
        : '';

    return [
        '<style type="text/css">',
        fontFace,
        `@page { size: ${width}px ${height}px; margin: 0; }`,
        'html, body {',
        '  margin: 0 !important;',
        '  padding: 0 !important;',
        '  width: 100% !important;',
        '  height: auto !important;',
        '  overflow: visible !important;',
        '  background: #fff !important;',
        '  color: #000 !important;',
        '}',
        'body {',
        '  box-sizing: border-box !important;',
        '  writing-mode: vertical-rl !important;',
        '  -webkit-writing-mode: vertical-rl !important;',
        '  -epub-writing-mode: vertical-rl !important;',
        '  text-orientation: upright !important;',
        '  -webkit-text-orientation: upright !important;',
        '  -epub-text-orientation: upright !important;',
        '  direction: rtl !important;',
        '  unicode-bidi: plaintext !important;',
        '  line-break: strict !important;',
        '  word-break: normal !important;',
        '  letter-spacing: 0 !important;',
        '  word-spacing: 0 !important;',
        `  font-size: ${fontSize}px !important;`,
        `  font-weight: ${fontWeight} !important;`,
        `  line-height: ${lineHeight} !important;`,
        `  text-align: ${textAlign} !important;`,
        '  text-justify: none !important;',
        fontPath ? '  font-family: "ZenOldMincho", serif !important;' : '',
        `  padding: ${padTop}px ${padRight}px ${padBottom}px ${padLeft}px !important;`,
        '}',
        'body * {',
        '  writing-mode: inherit !important;',
        '  -webkit-writing-mode: inherit !important;',
        '  -epub-writing-mode: inherit !important;',
        '  text-orientation: inherit !important;',
        '  -webkit-text-orientation: inherit !important;',
        '  -epub-text-orientation: inherit !important;',
        '  direction: inherit !important;',
        '  unicode-bidi: inherit !important;',
        '}',
        'ruby {',
        '  ruby-position: over;',
        '  ruby-align: center;',
        '  ruby-merge: separate;',
        '  line-height: 1 !important;',
        '}',
        'rt, rp {',
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
        '}',
        '.xtc-page-break {',
        '  break-before: page !important;',
        '  page-break-before: always !important;',
        '  width: 0 !important;',
        '  height: 0 !important;',
        '  margin: 0 !important;',
        '  padding: 0 !important;',
        '  overflow: hidden !important;',
        '}',
        '</style>'
    ].join('\n');
}

function injectVerticalPrintCss(html, settings) {
    const css = buildVerticalPrintCss(settings);
    if (html.includes('</head>')) {
        return html.replace('</head>', `${css}\n</head>`);
    }
    return css + html;
}

function normalizeHtmlSource(html, sourceDir, settings) {
    let updated = stripXmlDeclaration(html);
    updated = replaceCharsetMeta(updated);
    updated = injectBaseHref(updated, sourceDir);
    updated = stripScriptTags(updated);
    updated = replaceAozoraPageBreaks(updated);
    updated = injectVerticalPrintCss(updated, settings);
    return updated;
}

function parseHtmlMetadata(html, fallbackTitle) {
    const titleMatch =
        html.match(/<meta\b[^>]*name\s*=\s*["']DC\.Title["'][^>]*content\s*=\s*["']([^"']+)["']/i) ||
        html.match(/<meta\b[^>]*property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']+)["']/i) ||
        html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) ||
        html.match(/<h1\b[^>]*class\s*=\s*["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i);

    const authorMatch =
        html.match(/<meta\b[^>]*name\s*=\s*["']DC\.Creator["'][^>]*content\s*=\s*["']([^"']+)["']/i) ||
        html.match(/<meta\b[^>]*name\s*=\s*["']author["'][^>]*content\s*=\s*["']([^"']+)["']/i) ||
        html.match(/<h2\b[^>]*class\s*=\s*["'][^"']*\bauthor\b[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i);

    const cleanText = (text) => String(text || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

    return {
        title: cleanText(titleMatch && titleMatch[1]) || fallbackTitle || 'Unknown',
        author: cleanText(authorMatch && authorMatch[1]) || ''
    };
}

async function loadPdfJsModule() {
    if (!pdfjsModulePromise) {
        globalThis.Path2D = globalThis.Path2D || Path2D;
        globalThis.DOMMatrix = globalThis.DOMMatrix || DOMMatrix;
        globalThis.ImageData = globalThis.ImageData || ImageData;
        pdfjsModulePromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((module) => {
            return module;
        });
    }

    return await pdfjsModulePromise;
}

class SkiaCanvasFactory {
    create(width, height) {
        if (width <= 0 || height <= 0) {
            throw new Error('Invalid canvas size');
        }

        const canvas = new Canvas(width, height);
        return {
            canvas,
            context: canvas.getContext('2d')
        };
    }

    reset(canvasAndContext, width, height) {
        if (!canvasAndContext || !canvasAndContext.canvas) {
            throw new Error('Canvas is not specified');
        }
        if (width <= 0 || height <= 0) {
            throw new Error('Invalid canvas size');
        }

        canvasAndContext.canvas.width = width;
        canvasAndContext.canvas.height = height;
    }

    destroy(canvasAndContext) {
        if (!canvasAndContext || !canvasAndContext.canvas) {
            return;
        }

        canvasAndContext.canvas.width = 0;
        canvasAndContext.canvas.height = 0;
        canvasAndContext.canvas = null;
        canvasAndContext.context = null;
    }
}

async function rasterizePdfPage(pdfDocument, pageIndex, scale) {
    const page = await pdfDocument.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale });
    const canvas = new Canvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const canvasContext = canvas.getContext('2d');

    await page.render({
        canvasContext,
        viewport,
        useRequestAnimationFrame: false
    }).promise;

    const png = await canvas.toBuffer('png');
    try {
        page.cleanup();
    } catch {}
    return png;
}

async function loadChromiumBrowser() {
    const executablePath = getDefaultBrowserExecutable();
    if (!executablePath) {
        throw new Error('No Chrome/Edge executable found. Set CHROME_PATH or install Chrome.');
    }

    return await chromium.launch({
        headless: true,
        executablePath,
        args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
}

class HtmlBrowserSession {
    constructor(htmlPath, settings) {
        this.htmlPath = htmlPath;
        this.settings = settings;
        this.sourceDir = path.dirname(htmlPath);
        this.tempDir = null;
        this.browser = null;
        this.page = null;
        this.pdfBuffer = null;
        this.pdfDocument = null;
        this.pageCount = 0;
        this.info = { title: '', author: '' };
        this.toc = [];
        this.htmlFilePath = null;
        this.pageWidth = Number(settings?.width || 528);
        this.pageHeight = Number(settings?.height || 792);
    }

    async init(progressCallback) {
        const emitProgress = (current, total, meta = {}) => {
            if (typeof progressCallback === 'function') {
                progressCallback(current, total, meta);
            }
        };

        emitProgress(0, 0, { stage: 'init', message: 'Opening HTML...' });
        const sourceBuffer = fs.readFileSync(this.htmlPath);
        const decoded = decodeHtmlBuffer(sourceBuffer);
        const fallbackTitle = path.basename(this.htmlPath, path.extname(this.htmlPath));
        this.info = parseHtmlMetadata(decoded.text, fallbackTitle);

        emitProgress(0, 0, { stage: 'init', message: 'Preparing HTML...' });
        this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epub-html-'));
        this.htmlFilePath = path.join(this.tempDir, 'document.html');

        const normalizedHtml = normalizeHtmlSource(decoded.text, this.sourceDir, this.settings);
        fs.writeFileSync(this.htmlFilePath, normalizedHtml, 'utf8');

        emitProgress(0, 0, { stage: 'init', message: 'Launching browser...' });
        this.browser = await loadChromiumBrowser();
        this.page = await this.browser.newPage({
            viewport: {
                width: this.pageWidth,
                height: this.pageHeight
            },
            deviceScaleFactor: 1
        });

        const fileUrl = pathToFileURL(this.htmlFilePath).href;
        await this.page.goto(fileUrl, { waitUntil: 'load' });
        await this.page.waitForLoadState('networkidle').catch(() => {});
        await this.page.evaluate(async () => {
            if (document.fonts && document.fonts.ready) {
                try {
                    await document.fonts.ready;
                } catch {}
            }
        });

        emitProgress(0, 0, { stage: 'measure', message: 'Measuring layout...' });
        this.toc = await this.page.evaluate((pageWidth) => {
            const body = document.body;
            const root = document.documentElement;
            const computed = getComputedStyle(body || root);
            const paddingLeft = parseFloat(computed.paddingLeft || '0') || 0;
            const selectors = [
                'h3.o-midashi',
                'h4.o-midashi',
                'h3.naka-midashi',
                'h4.naka-midashi',
                '.o-midashi',
                '.naka-midashi'
            ].join(', ');
            const entries = [];
            const seen = new Set();

            for (const el of Array.from(document.querySelectorAll(selectors))) {
                const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
                if (!text) {
                    continue;
                }

                const key = `${text}|${el.tagName}|${el.className || ''}`;
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);

                const rect = el.getBoundingClientRect();
                const pageIndex = Math.max(0, Math.floor((paddingLeft - rect.left) / Math.max(1, pageWidth)));
                entries.push({
                    title: text,
                    page: pageIndex
                });
            }

            return entries;
        }, this.pageWidth);

        emitProgress(0, 0, { stage: 'measure', message: 'Rendering PDF...' });
        this.pdfBuffer = await this.page.pdf({
            width: `${this.pageWidth}px`,
            height: `${this.pageHeight}px`,
            printBackground: true,
            preferCSSPageSize: true,
            margin: { top: '0', right: '0', bottom: '0', left: '0' }
        });

        const pdfjs = await loadPdfJsModule();
        this.pdfDocument = await pdfjs.getDocument({
            data: new Uint8Array(this.pdfBuffer),
            useWorkerFetch: false,
            isEvalSupported: false,
            disableFontFace: true,
            CanvasFactory: SkiaCanvasFactory,
            isOffscreenCanvasSupported: false
        }).promise;
        this.pageCount = this.pdfDocument.numPages;
        if (!this.toc || this.toc.length === 0) {
            this.toc = [{ title: this.info.title || fallbackTitle, page: 0 }];
        }

        return {
            info: this.info,
            toc: this.toc,
            pageCount: this.pageCount
        };
    }

    async renderPage(pageIndex) {
        if (!this.pdfDocument) {
            throw new Error('HTML browser session not initialized');
        }

        if (pageIndex < 0 || pageIndex >= this.pageCount) {
            throw new Error(`Page index out of range: ${pageIndex}`);
        }

        const scale = 4 / 3;
        return await rasterizePdfPage(this.pdfDocument, pageIndex, scale);
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
        if (this.pdfDocument) {
            try {
                await this.pdfDocument.destroy();
            } catch {}
            this.pdfDocument = null;
        }

        if (this.page) {
            await this.page.close().catch(() => {});
            this.page = null;
        }

        if (this.browser) {
            await this.browser.close().catch(() => {});
            this.browser = null;
        }

        if (this.tempDir) {
            fs.rmSync(this.tempDir, { recursive: true, force: true });
            this.tempDir = null;
        }
    }
}

async function renderHtmlPages(htmlPath, settings, progressCallback) {
    const session = new HtmlBrowserSession(htmlPath, settings);
    try {
        await session.init(progressCallback);

        const pages = [];
        for (let i = 0; i < session.pageCount; i++) {
            const renderStart = performance.now();
            const raw = await session.renderPageRaw(i);
            pages.push(raw);
            if (typeof progressCallback === 'function') {
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
    HtmlBrowserSession,
    isHtmlDocumentInput,
    renderHtmlPages
};
