/**
 * Settings management and defaults for CLI converter
 */

const fs = require('fs');
const path = require('path');

const BUNDLED_ZEN_OLD_MINCHO_FONT = path.join(
    __dirname,
    '..',
    'assets',
    'fonts',
    'Zen_Old_Mincho',
    'ZenOldMincho-Regular.ttf'
);

// Device presets
const DEVICES = {
    'xteink-x4': { width: 480, height: 800, name: 'Xteink X4' },
    'xteink-x3': { width: 528, height: 792, name: 'Xteink X3' },
    'custom': { width: 480, height: 800, name: 'Custom' }
};

// Text alignment values for CREngine
const TEXT_ALIGN = {
    'left': 0,
    'right': 1,
    'center': 2,
    'justify': 3
};

const VALID_MARGIN_UNITS = new Set(['px', 'em', 'line']);

function resolveMarginSide(side, fontSize, lineHeight) {
    if (side === null || side === undefined) {
        return 0;
    }

    if (typeof side === 'number') {
        return Math.max(0, side);
    }

    if (typeof side === 'string') {
        const parsed = Number(side);
        return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
    }

    if (typeof side === 'object') {
        const value = Number(side.value ?? side.amount ?? side.size ?? 0);
        const unit = String(side.unit || 'px').toLowerCase();
        const safeValue = Number.isFinite(value) ? value : 0;
        const lineHeightPx = fontSize * (lineHeight / 100);

        switch (unit) {
            case 'em':
            case 'ch':
            case 'char':
            case 'chars':
                return Math.max(0, safeValue * fontSize);
            case 'line':
            case 'lh':
                return Math.max(0, safeValue * lineHeightPx);
            case 'px':
            default:
                return Math.max(0, safeValue);
        }
    }

    return 0;
}

function resolveMargins(margins, fontSize, lineHeight) {
    if (typeof margins === 'number' || typeof margins === 'string') {
        const value = resolveMarginSide(margins, fontSize, lineHeight);
        return { top: Math.round(value), right: Math.round(value), bottom: Math.round(value), left: Math.round(value) };
    }

    const source = margins && typeof margins === 'object' ? margins : {};
    return {
        top: Math.round(resolveMarginSide(source.top, fontSize, lineHeight)),
        right: Math.round(resolveMarginSide(source.right, fontSize, lineHeight)),
        bottom: Math.round(resolveMarginSide(source.bottom, fontSize, lineHeight)),
        left: Math.round(resolveMarginSide(source.left, fontSize, lineHeight))
    };
}

// Default settings
const DEFAULT_SETTINGS = {
    device: 'xteink-x3',
    width: 528,
    height: 792,
    layout: {
        mode: 'vertical-jp'
    },
    font: {
        path: null,  // Required: path to TTF/OTF font file
        size: 24,
        weight: 400
    },
    margins: {
        left: 16,
        top: 16,
        right: 16,
        bottom: 16
    },
    lineHeight: 120,
    textAlign: 'justify',
    hyphenation: {
        enabled: true,
        language: 'en'
    },
    output: {
        format: 'xtc',  // 'xtc' (1-bit) or 'xtch' (2-bit)
        dithering: true,
        ditherStrength: 0.7,
        negative: false
    },
    optimizer: {
        removeCss: true,
        stripFonts: true,
        processImages: true,
        removeUnsupportedImages: true,
        grayscale: true,
        maxImageWidth: 480,
        injectCss: true,
        recursive: true,
        include: '*.epub',
        exclude: null
    }
};

/**
 * Load settings from JSON file
 */
function loadSettings(configPath) {
    const configDir = configPath ? path.dirname(path.resolve(configPath)) : process.cwd();

    if (!configPath || !fs.existsSync(configPath)) {
        return { ...DEFAULT_SETTINGS, __configDir: configDir };
    }

    try {
        const content = fs.readFileSync(configPath, 'utf8');
        const userSettings = JSON.parse(content);
        return { ...mergeSettings(DEFAULT_SETTINGS, userSettings), __configDir: configDir };
    } catch (err) {
        throw new Error(`Failed to load config file: ${err.message}`);
    }
}

/**
 * Deep merge settings objects
 */
function mergeSettings(defaults, user) {
    const result = { ...defaults };

    for (const key of Object.keys(user)) {
        if (user[key] !== null && typeof user[key] === 'object' && !Array.isArray(user[key])) {
            result[key] = mergeSettings(defaults[key] || {}, user[key]);
        } else {
            result[key] = user[key];
        }
    }

    return result;
}

/**
 * Resolve settings with device preset
 */
function resolveSettings(settings) {
    const resolved = { ...settings };
    const configDir = resolved.__configDir || process.cwd();

    // Apply device preset dimensions if not custom
    if (settings.device !== 'custom' && DEVICES[settings.device]) {
        resolved.width = DEVICES[settings.device].width;
        resolved.height = DEVICES[settings.device].height;
    }

    // Convert text align string to CREngine value
    resolved.textAlignValue = TEXT_ALIGN[settings.textAlign] || 3;

    // Resolve font path to absolute or fall back to a local system font
    if (resolved.font.path) {
        resolved.font.path = path.isAbsolute(resolved.font.path)
            ? resolved.font.path
            : path.resolve(configDir, resolved.font.path);
    } else {
        resolved.font.path = findDefaultFontPath();
    }

    if (isZenOldMinchoFont(resolved.font.path) || (resolved.layout && resolved.layout.mode === 'vertical-jp')) {
        resolved.hyphenation = {
            ...resolved.hyphenation,
            language: 'ja'
        };
    }

    resolved.margins = resolveMargins(resolved.margins, resolved.font.size, resolved.lineHeight);
    resolved.readDirection = resolved.layout && resolved.layout.mode === 'vertical-jp' ? 2 : 0;

    delete resolved.__configDir;

    return resolved;
}

/**
 * Find a reasonable local font for the current platform.
 * This keeps the CLI usable without manual font setup on a fresh machine.
 */
function findDefaultFontPath() {
    const platform = process.platform;
    const candidates = [];

    if (fs.existsSync(BUNDLED_ZEN_OLD_MINCHO_FONT)) {
        candidates.push(BUNDLED_ZEN_OLD_MINCHO_FONT);
    }

    if (platform === 'win32') {
        const fontDir = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
        candidates.push(
            path.join(fontDir, 'times.ttf'),
            path.join(fontDir, 'timesnewroman.ttf'),
            path.join(fontDir, 'timesbd.ttf'),
            path.join(fontDir, 'arial.ttf'),
            path.join(fontDir, 'calibri.ttf'),
            path.join(fontDir, 'cambria.ttf'),
            path.join(fontDir, 'segoeui.ttf')
        );
    } else if (platform === 'darwin') {
        candidates.push(
            '/System/Library/Fonts/Supplemental/Times New Roman.ttf',
            '/System/Library/Fonts/Supplemental/Arial.ttf',
            '/System/Library/Fonts/Supplemental/Georgia.ttf',
            '/System/Library/Fonts/Supplemental/Palatino.ttf',
            '/Library/Fonts/Times New Roman.ttf',
            '/Library/Fonts/Arial.ttf'
        );
    } else {
        candidates.push(
            '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf',
            '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
            '/usr/share/fonts/truetype/liberation2/LiberationSerif-Regular.ttf',
            '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
            '/usr/share/fonts/truetype/noto/NotoSerif-Regular.ttf',
            '/usr/share/fonts/truetype/freefont/FreeSerif.ttf',
            '/usr/share/fonts/truetype/msttcorefonts/Times_New_Roman.ttf'
        );
    }

    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) {
            return candidate;
        }
    }

    if (platform === 'win32') {
        const fontDir = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
        const fallbackPatterns = [
            /^times.*\.(ttf|otf)$/i,
            /^arial.*\.(ttf|otf)$/i,
            /^calibri.*\.(ttf|otf)$/i,
            /^cambria.*\.(ttf|otf)$/i,
            /^segoeui.*\.(ttf|otf)$/i
        ];

        try {
            const entries = fs.readdirSync(fontDir);
            for (const pattern of fallbackPatterns) {
                const match = entries.find(name => pattern.test(name));
                if (match) {
                    const found = path.join(fontDir, match);
                    if (fs.existsSync(found)) {
                        return found;
                    }
                }
            }
        } catch {
            // Ignore font directory scan failures and fall through to null.
        }
    }

    return null;
}

function isZenOldMinchoFont(fontPath) {
    if (!fontPath) return false;
    const normalized = fontPath.replace(/\\/g, '/').toLowerCase();
    return normalized.includes('/zen_old_mincho/') || normalized.includes('zenoldmincho');
}

/**
 * Validate settings
 */
function validateSettings(settings) {
    const errors = [];

    if (!settings.font.path) {
        errors.push('Font path is required. Set font.path in your config file.');
    } else if (!fs.existsSync(settings.font.path)) {
        errors.push(`Font file not found: ${settings.font.path}`);
    }

    if (settings.width <= 0 || settings.height <= 0) {
        errors.push('Width and height must be positive integers');
    }

    if (settings.font.size < 8 || settings.font.size > 100) {
        errors.push('Font size must be between 8 and 100');
    }

    if (settings.output.ditherStrength < 0 || settings.output.ditherStrength > 1) {
        errors.push('Dither strength must be between 0 and 1');
    }

    if (settings.margins !== undefined) {
        const marginSource = typeof settings.margins === 'number' || typeof settings.margins === 'string'
            ? { top: settings.margins, right: settings.margins, bottom: settings.margins, left: settings.margins }
            : settings.margins;
        if (marginSource && typeof marginSource === 'object') {
            for (const side of ['top', 'right', 'bottom', 'left']) {
                const entry = marginSource[side];
                if (entry === null || entry === undefined) {
                    continue;
                }

                if (typeof entry === 'object') {
                    const unit = String(entry.unit || 'px').toLowerCase();
                    if (!VALID_MARGIN_UNITS.has(unit)) {
                        errors.push(`Invalid margin unit for ${side}: ${entry.unit}`);
                    }
                    const value = Number(entry.value ?? entry.amount ?? 0);
                    if (!Number.isFinite(value) || value < 0) {
                        errors.push(`Margin value for ${side} must be a non-negative number`);
                    }
                } else {
                    const value = Number(entry);
                    if (!Number.isFinite(value) || value < 0) {
                        errors.push(`Margin value for ${side} must be a non-negative number`);
                    }
                }
            }
        }
    }

    const validLayoutModes = ['horizontal', 'vertical-jp'];
    if (settings.layout && !validLayoutModes.includes(settings.layout.mode)) {
        errors.push(`Invalid layout mode: ${settings.layout.mode}. Must be 'horizontal' or 'vertical-jp'`);
    }

    const validFormats = ['xtc', 'xtch'];
    if (!validFormats.includes(settings.output.format)) {
        errors.push(`Invalid output format: ${settings.output.format}. Must be 'xtc' or 'xtch'`);
    }

    validateOptimizerFields(settings, errors);

    return errors;
}

/**
 * Validate optimizer-specific settings (no font.path required)
 */
function validateOptimizerSettings(settings) {
    const errors = [];
    validateOptimizerFields(settings, errors);
    return errors;
}

function validateOptimizerFields(settings, errors) {
    if (settings.optimizer) {
        if (settings.optimizer.maxImageWidth !== undefined &&
            (settings.optimizer.maxImageWidth < 1 || settings.optimizer.maxImageWidth > 2048)) {
            errors.push('optimizer.maxImageWidth must be between 1 and 2048');
        }
    }
}

/**
 * Generate default config file content
 */
function generateDefaultConfig(outputPath) {
    const bundledFontPath = path.relative(
        path.dirname(path.resolve(outputPath || path.join(__dirname, 'settings.json'))),
        BUNDLED_ZEN_OLD_MINCHO_FONT
    ).split(path.sep).join('/');

    const config = {
        ...DEFAULT_SETTINGS,
        layout: {
            ...DEFAULT_SETTINGS.layout,
            mode: 'horizontal'
        },
        font: {
            ...DEFAULT_SETTINGS.font,
            path: bundledFontPath
        },
        margins: {
            top: { value: DEFAULT_SETTINGS.margins.top, unit: 'px' },
            right: { value: DEFAULT_SETTINGS.margins.right, unit: 'px' },
            bottom: { value: DEFAULT_SETTINGS.margins.bottom, unit: 'px' },
            left: { value: DEFAULT_SETTINGS.margins.left, unit: 'px' }
        },
        hyphenation: {
            ...DEFAULT_SETTINGS.hyphenation,
            language: 'ja'
        }
    };

    return JSON.stringify(config, null, 2);
}

module.exports = {
    DEVICES,
    TEXT_ALIGN,
    DEFAULT_SETTINGS,
    findDefaultFontPath,
    loadSettings,
    resolveSettings,
    validateSettings,
    validateOptimizerSettings,
    generateDefaultConfig
};
