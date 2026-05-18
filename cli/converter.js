/**
 * Core EPUB to XTC/XTCH converter
 * Uses CREngine WASM for EPUB rendering
 */

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { applyDithering, applyNegative } = require('./dither');
const { encodeXTG, encodeXTH, buildXTCContainer } = require('./encoder');
const { isVerticalJapaneseLayout, renderVerticalPages } = require('./browser-renderer');
const { renderHtmlPages } = require('./html-renderer');

let Module = null;
let renderer = null;

/**
 * Destroy renderer and free WASM memory
 */
function destroyRenderer() {
    if (renderer) {
        renderer.delete();  // Emscripten destructor - frees WASM heap
        renderer = null;
    }
}

/**
 * Initialize CREngine WASM module
 */
async function initWasm() {
    if (Module) return;

    const wasmPath = path.join(__dirname, '..', 'web', 'crengine.js');

    if (!fs.existsSync(wasmPath)) {
        throw new Error(`CREngine WASM not found at: ${wasmPath}`);
    }

    // Load CREngine module
    const CREngine = require(wasmPath);
    Module = await CREngine();
}

function injectVerticalJapaneseCss(html) {
    const safeInset = 8;
    const rubyInset = 6;
    const blockEndReserve = 8;
    const padTop = 16 + safeInset + rubyInset;
    const padRight = 16 + safeInset;
    const padBottom = 16 + safeInset;
    const padLeft = 16 + safeInset + rubyInset + blockEndReserve;
    const verticalCss = '<style type="text/css">' +
        'html, body { margin: 0 !important; padding: 0 !important; width: 100% !important; height: 100% !important; overflow: auto !important; scrollbar-gutter: stable both-edges !important; background: #fff !important; color: #000 !important; }' +
        'body { writing-mode: vertical-rl !important; -webkit-writing-mode: vertical-rl !important; -epub-writing-mode: vertical-rl !important; text-orientation: upright !important; -webkit-text-orientation: upright !important; -epub-text-orientation: upright !important; direction: rtl !important; unicode-bidi: plaintext !important; line-break: strict !important; word-break: normal !important; letter-spacing: 0 !important; word-spacing: 0 !important; text-align: start !important; text-justify: none !important; box-sizing: border-box !important; padding: ' + padTop + 'px ' + padRight + 'px ' + padBottom + 'px ' + padLeft + 'px !important; }' +
        'body * { writing-mode: inherit !important; -webkit-writing-mode: inherit !important; -epub-writing-mode: inherit !important; text-orientation: inherit !important; -webkit-text-orientation: inherit !important; -epub-text-orientation: inherit !important; direction: inherit !important; unicode-bidi: inherit !important; }' +
        'p { text-indent: 0 !important; margin: 0.25em 0 !important; }' +
        'ruby { ruby-position: over; ruby-align: center; ruby-merge: separate; line-height: 1 !important; }' +
        'rt, rp { writing-mode: horizontal-tb !important; -webkit-writing-mode: horizontal-tb !important; -epub-writing-mode: horizontal-tb !important; text-orientation: mixed !important; -webkit-text-orientation: mixed !important; -epub-text-orientation: mixed !important; font-size: 0.5em !important; line-height: 1 !important; margin: 0 !important; padding: 0 !important; letter-spacing: 0 !important; white-space: nowrap !important; }' +
        '</style>';

    if (html.indexOf('</head>') !== -1) {
        return html.replace('</head>', verticalCss + '</head>');
    }

    return verticalCss + html;
}

function injectVerticalJapaneseOpf(opf) {
    let updated = opf;

    if (!/\bdir\s*=\s*["']rtl["']/i.test(updated)) {
        updated = updated.replace(/<package\b([^>]*)>/i, function(match, attrs) {
            if (/\bdir\s*=/i.test(attrs)) {
                return match;
            }
            return '<package' + attrs + ' dir="rtl">';
        });
    }

    if (!/page-progression-direction\s*=/i.test(updated)) {
        updated = updated.replace(/<spine\b([^>]*)>/i, function(match, attrs) {
            if (/page-progression-direction\s*=/i.test(attrs)) {
                return match;
            }
            return '<spine' + attrs + ' page-progression-direction="rtl">';
        });
    }

    if (!/name\s*=\s*["']primary-writing-mode["']/i.test(updated)) {
        updated = updated.replace(/<metadata\b([^>]*)>/i, function(match) {
            return match + '\n    <meta name="primary-writing-mode" content="vertical-rl"/>';
        });
    }

    return updated;
}

function getLayoutStyleSheet(settings) {
    if (isVerticalJapaneseLayout(settings)) {
        return [
            'html, body {',
            '  margin: 0 !important;',
            '  padding: 0 !important;',
            '  width: 100% !important;',
            '  height: 100% !important;',
            '  overflow: auto !important;',
            '  background: #fff !important;',
            '  color: #000 !important;',
            '}',
            'body {',
            '  writing-mode: vertical-rl !important;',
            '  -epub-writing-mode: vertical-rl !important;',
            '  -webkit-writing-mode: vertical-rl !important;',
            '  text-orientation: upright !important;',
            '  -epub-text-orientation: upright !important;',
            '  -webkit-text-orientation: upright !important;',
            '  direction: rtl !important;',
            '  unicode-bidi: plaintext !important;',
            '  line-break: strict !important;',
            '  word-break: normal !important;',
            '  letter-spacing: 0 !important;',
            '  word-spacing: 0 !important;',
            '  text-align: start !important;',
            '  text-justify: none !important;',
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
            'p { text-indent: 0; margin: 0.25em 0; }',
            'ruby { ruby-position: over; ruby-align: center; ruby-merge: separate; line-height: 1 !important; }',
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
            '  transform: none !important;',
            '  rotate: none !important;',
            '}'
        ].join('\n');
    }

    return [
        'html, body, body * {',
        '  writing-mode: horizontal-tb !important;',
        '  -webkit-writing-mode: horizontal-tb !important;',
        '  text-orientation: mixed !important;',
        '  -webkit-text-orientation: mixed !important;',
        '  direction: ltr !important;',
        '  unicode-bidi: plaintext !important;',
        '}'
    ].join('\n');
}

function applyLayoutStyleSheet(settings) {
    if (renderer && renderer.setStyleSheet) {
        renderer.setStyleSheet(getLayoutStyleSheet(settings));
    }
}

async function prepareEpubBufferForLayoutMode(epubPath, settings) {
    const sourceData = fs.readFileSync(epubPath);

    if (!isVerticalJapaneseLayout(settings)) {
        return sourceData;
    }

    const zip = await JSZip.loadAsync(sourceData);
    const files = Object.keys(zip.files);

    for (const filePath of files) {
        if (/\.(html|xhtml|htm)$/i.test(filePath)) {
            const html = await zip.files[filePath].async('string');
            zip.file(filePath, injectVerticalJapaneseCss(html));
            continue;
        }

        if (/\.opf$/i.test(filePath)) {
            const opf = await zip.files[filePath].async('string');
            zip.file(filePath, injectVerticalJapaneseOpf(opf));
        }
    }

    return await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 9 }
    });
}

/**
 * Create renderer with specified dimensions
 */
function createRenderer(width, height) {
    if (!Module) {
        throw new Error('WASM module not initialized. Call initWasm() first.');
    }
    destroyRenderer();  // Clean up existing renderer before creating new one
    renderer = new Module.EpubRenderer(width, height);

    return renderer;
}

/**
 * Register font from file
 */
async function registerFont(fontPath) {
    if (!renderer) {
        throw new Error('Renderer not initialized');
    }

    const fontData = fs.readFileSync(fontPath);
    const fontName = path.basename(fontPath);

    const ptr = Module.allocateMemory(fontData.length);
    Module.HEAPU8.set(new Uint8Array(fontData), ptr);
    renderer.registerFontFromMemory(ptr, fontData.length, fontName);
    Module.freeMemory(ptr);

    return fontName;
}

/**
 * Load EPUB file into renderer
 */
async function loadEpub(epubPath) {
    const epubData = fs.readFileSync(epubPath);
    return await loadEpubBuffer(epubData);
}

async function loadEpubBuffer(epubData) {
    if (!renderer) {
        throw new Error('Renderer not initialized');
    }

    const ptr = Module.allocateMemory(epubData.length);
    Module.HEAPU8.set(new Uint8Array(epubData), ptr);

    try {
        renderer.loadEpubFromMemory(ptr, epubData.length);

        // Disable built-in status bar (must be after loading document)
        renderer.configureStatusBar(false, false, false, false, false, false, false, false, false);
    } finally {
        Module.freeMemory(ptr);
    }

    return {
        pageCount: renderer.getPageCount(),
        info: renderer.getDocumentInfo() || {},
        toc: renderer.getToc() || []
    };
}

/**
 * Apply rendering settings
 */
function applySettings(settings) {
    if (!renderer) {
        throw new Error('Renderer not initialized');
    }

    const { margins, font, lineHeight, textAlignValue, hyphenation } = settings;

    renderer.setMargins(
        margins.left,
        margins.top,
        margins.right,
        margins.bottom
    );
    renderer.setFontSize(font.size);
    renderer.setFontWeight(font.weight);
    renderer.setInterlineSpace(lineHeight);
    renderer.setTextAlign(textAlignValue);

    if (hyphenation.enabled) {
        renderer.setHyphenation(2); // Dictionary-based
        if (renderer.setHyphenationLanguage) {
            renderer.setHyphenationLanguage(hyphenation.language);
        }
    } else {
        renderer.setHyphenation(0); // Disabled
    }
}

/**
 * Render a single page
 */
function renderPage(pageNum) {
    if (!renderer) {
        throw new Error('Renderer not initialized');
    }

    renderer.goToPage(pageNum);
    renderer.renderCurrentPage();

    const frameBuffer = renderer.getFrameBuffer();
    if (!frameBuffer || frameBuffer.length === 0) {
        throw new Error(`Empty frame buffer for page ${pageNum}`);
    }

    // Copy buffer (frame buffer may be reused by WASM)
    return new Uint8ClampedArray(frameBuffer);
}

/**
 * Convert single EPUB to XTC/XTCH
 */
async function convertEpub(epubPath, outputPath, settings, progressCallback) {
    const { width, height, output } = settings;
    const isHQ = output.format === 'xtch';
    const bits = isHQ ? 2 : 1;
    const readDirection = settings.readDirection || 0;

    // Japanese vertical layout needs a real browser renderer because CREngine
    // does not honor writing-mode CSS in this build.
    if (isVerticalJapaneseLayout(settings)) {
        destroyRenderer();

        const rendered = await renderVerticalPages(epubPath, settings, progressCallback);
        const pages = [];

        for (let i = 0; i < rendered.pages.length; i++) {
            let imageData = rendered.pages[i];

            if (output.dithering) {
                imageData = applyDithering(imageData.data, imageData.width, imageData.height, bits, output.ditherStrength);
                imageData = {
                    data: imageData,
                    width: rendered.pages[i].width,
                    height: rendered.pages[i].height
                };
            }

            if (output.negative) {
                applyNegative(imageData.data);
            }

            const encoded = isHQ
                ? encodeXTH(imageData.data, imageData.width, imageData.height)
                : encodeXTG(imageData.data, imageData.width, imageData.height);
            pages.push(encoded);
        }

        const metadata = {
            title: rendered.info.title || path.basename(epubPath, '.epub'),
            author: rendered.info.author || rendered.info.authors || ''
        };

        const container = buildXTCContainer(pages, metadata, rendered.toc, width, height, isHQ, readDirection);
        fs.writeFileSync(outputPath, container);

        return {
            outputPath,
            pageCount: rendered.pageCount,
            format: output.format
        };
    }

    // Initialize and setup
    await initWasm();
    createRenderer(width, height);

    // Register font
    await registerFont(settings.font.path);

    // Load EPUB, optionally with a temporary vertical-writing overlay
    const epubData = await prepareEpubBufferForLayoutMode(epubPath, settings);
    const { pageCount, info, toc } = await loadEpubBuffer(epubData);

    if (pageCount === 0) {
        throw new Error('EPUB has no pages');
    }

    // Apply settings after loading (affects pagination)
    applySettings(settings);
    applyLayoutStyleSheet(settings);

    // Re-get page count after settings (pagination may change)
    const totalPages = renderer.getPageCount();

    // Render all pages
    const pages = [];
    for (let i = 0; i < totalPages; i++) {
        const pageStart = Date.now();
        // Render page
        let imageData = renderPage(i);

        // Apply dithering if enabled
        if (output.dithering) {
            imageData = applyDithering(imageData, width, height, bits, output.ditherStrength);
        }

        // Apply negative if enabled
        if (output.negative) {
            applyNegative(imageData);
        }

        // Encode page
        const encoded = isHQ
            ? encodeXTH(imageData, width, height)
            : encodeXTG(imageData, width, height);
        pages.push(encoded);

        // Progress callback
        if (progressCallback) {
            progressCallback(i + 1, totalPages, {
                stage: 'render',
                pageIndex: i,
                pageTimeMs: Math.max(0, Date.now() - pageStart)
            });
        }
    }

    // Build container
    const metadata = {
        title: info.title || path.basename(epubPath, '.epub'),
        author: info.author || info.authors || ''
    };

    const container = buildXTCContainer(pages, metadata, toc, width, height, isHQ, readDirection);

    // Write output
    fs.writeFileSync(outputPath, container);

    return {
        outputPath,
        pageCount: totalPages,
        format: output.format
    };
}

async function convertHtml(htmlPath, outputPath, settings, progressCallback) {
    const { width, height, output } = settings;
    const isHQ = output.format === 'xtch';
    const bits = isHQ ? 2 : 1;
    const readDirection = 2;

    const rendered = await renderHtmlPages(htmlPath, settings, progressCallback);
    const pages = [];

    for (let i = 0; i < rendered.pages.length; i++) {
        let imageData = rendered.pages[i];

        if (output.dithering) {
            imageData = applyDithering(imageData.data, imageData.width, imageData.height, bits, output.ditherStrength);
            imageData = {
                data: imageData,
                width: rendered.pages[i].width,
                height: rendered.pages[i].height
            };
        }

        if (output.negative) {
            applyNegative(imageData.data);
        }

        const encoded = isHQ
            ? encodeXTH(imageData.data, imageData.width, imageData.height)
            : encodeXTG(imageData.data, imageData.width, imageData.height);
        pages.push(encoded);
    }

    const container = buildXTCContainer(
        pages,
        {
            title: rendered.info.title || path.basename(htmlPath, path.extname(htmlPath)),
            author: rendered.info.author || ''
        },
        rendered.toc,
        width,
        height,
        isHQ,
        readDirection
    );

    fs.writeFileSync(outputPath, container);

    return {
        outputPath,
        pageCount: rendered.pageCount,
        format: output.format
    };
}

/**
 * Get output path for an EPUB file
 */
function getOutputPath(inputPath, outputDir, format) {
    const basename = path.basename(inputPath, path.extname(inputPath));
    const extension = format === 'xtch' ? '.xtch' : '.xtc';
    return path.join(outputDir, basename + extension);
}

/**
 * Cleanup renderer resources
 */
function cleanup() {
    destroyRenderer();
}

module.exports = {
    initWasm,
    createRenderer,
    registerFont,
    loadEpub,
    loadEpubBuffer,
    applySettings,
    renderPage,
    convertHtml,
    convertEpub,
    getOutputPath,
    cleanup
};
