/**
 * Turns an upload into one or more base PNG pages.
 * Image formats go through sharp. PDF pages are rasterized with PDF.js.
 * Fonts become a specimen sheet drawn with opentype.js. JPEG 2000 / JPF
 * is decoded in pure JavaScript (the jpeg2000 package, Apache-2.0).
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const opentype = require('opentype.js');
const { JpxImage } = require('jpeg2000');
const { createCanvas, DOMMatrix, ImageData, Path2D } = require('@napi-rs/canvas');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tif', '.tiff', '.bmp', '.avif']);
const JP2_EXT = new Set(['.jpf', '.jp2', '.j2k', '.jpx', '.j2c', '.jpm']);
const PDF_EXT = new Set(['.pdf']);
const FONT_EXT = new Set(['.ttf', '.otf']);
const ALLOWED_EXT = new Set([...IMAGE_EXT, ...JP2_EXT, ...PDF_EXT, ...FONT_EXT]);

const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
const standardFontDataUrl = path.join(pdfjsRoot, 'standard_fonts') + path.sep;
const cMapUrl = path.join(pdfjsRoot, 'cmaps') + path.sep;

let pdfjs = null;

function loadPdfjs() {
  if (pdfjs) return pdfjs;
  // PDF.js asks for these DOM types while loading. Provide them from the
  // canvas package so it does not try to require the optional `canvas` module.
  global.DOMMatrix = global.DOMMatrix || DOMMatrix;
  global.ImageData = global.ImageData || ImageData;
  global.Path2D = global.Path2D || Path2D;
  pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  pdfjs.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.js');
  return pdfjs;
}

function extensionOf(name) {
  return path.extname(name || '').toLowerCase();
}

function isAllowed(name) {
  return ALLOWED_EXT.has(extensionOf(name));
}

function sourceTypeFor(name) {
  const ext = extensionOf(name);
  if (PDF_EXT.has(ext)) return 'pdf';
  if (FONT_EXT.has(ext)) return 'font';
  if (JP2_EXT.has(ext)) return 'jp2';
  if (IMAGE_EXT.has(ext)) return 'image';
  throw Object.assign(new Error(`Unsupported format “${ext || 'unknown'}”`), { status: 400 });
}

async function inspectFile(filePath, originalName) {
  const sourceType = sourceTypeFor(originalName);
  if (sourceType === 'pdf') {
    const doc = await openPdf(filePath);
    const pageCount = doc.numPages;
    await doc.destroy();
    return { sourceType, pageCount };
  }
  if (sourceType === 'font' || sourceType === 'jp2') {
    return { sourceType, pageCount: 1 };
  }
  const meta = await sharp(filePath).metadata();
  return { sourceType, pageCount: Math.max(1, meta.pages || 1) };
}

async function decodeBase(filePath, page) {
  if (page.sourceType === 'image') {
    return sharp(filePath, { page: page.pageIndex })
      .rotate()
      .flatten({ background: '#ffffff' })
      .png()
      .toBuffer();
  }
  if (page.sourceType === 'jp2') {
    return decodeJpeg2000(fs.readFileSync(filePath));
  }
  if (page.sourceType === 'pdf') {
    return renderPdfPage(filePath, page.pageIndex);
  }
  if (page.sourceType === 'font') {
    return renderFontSpecimen(filePath);
  }
  throw new Error('Unknown source type');
}

async function decodeJpeg2000(buffer) {
  const jpx = new JpxImage();
  try {
    jpx.parse(buffer);
  } catch (err) {
    throw new Error(`Could not read JPEG 2000 file (${err.message})`);
  }
  const channels = jpx.componentsCount;
  if (![1, 3, 4].includes(channels)) {
    throw new Error(`JPEG 2000 with ${channels} color components is not supported`);
  }
  if (!jpx.width || !jpx.height || !jpx.tiles?.length) {
    throw new Error('JPEG 2000 file did not contain an image');
  }

  const raw = Buffer.alloc(jpx.width * jpx.height * channels, channels === 1 ? 0 : 255);
  for (const tile of jpx.tiles) {
    const items = tile.items;
    if (!items) continue;
    for (let y = 0; y < tile.height; y += 1) {
      const dy = tile.top + y;
      if (dy < 0 || dy >= jpx.height) continue;
      const rowStart = Math.max(0, -tile.left);
      const destX = tile.left + rowStart;
      const copy = Math.min(tile.width - rowStart, jpx.width - destX);
      if (copy <= 0 || destX >= jpx.width) continue;
      const from = (y * tile.width + rowStart) * channels;
      raw.set(items.subarray(from, from + copy * channels), (dy * jpx.width + destX) * channels);
    }
  }

  return sharp(raw, { raw: { width: jpx.width, height: jpx.height, channels } })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();
}

function canvasFactory() {
  return {
    create(width, height) {
      const canvas = createCanvas(Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)));
      return { canvas, context: canvas.getContext('2d') };
    },
    reset(pair, width, height) {
      pair.canvas.width = Math.max(1, Math.ceil(width));
      pair.canvas.height = Math.max(1, Math.ceil(height));
    },
    destroy(pair) {
      pair.canvas.width = 0;
      pair.canvas.height = 0;
      pair.canvas = null;
      pair.context = null;
    },
  };
}

async function openPdf(filePath) {
  const lib = loadPdfjs();
  const data = new Uint8Array(fs.readFileSync(filePath));
  const task = lib.getDocument({
    data,
    canvasFactory: canvasFactory(),
    standardFontDataUrl,
    cMapUrl,
    cMapPacked: true,
    isEvalSupported: false,
    verbosity: 0,
  });
  return task.promise;
}

async function renderPdfPage(filePath, pageIndex) {
  const doc = await openPdf(filePath);
  try {
    const page = await doc.getPage(pageIndex + 1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2.4, 1800 / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const factory = canvasFactory();
    const pair = factory.create(viewport.width, viewport.height);
    pair.context.fillStyle = '#ffffff';
    pair.context.fillRect(0, 0, pair.canvas.width, pair.canvas.height);
    await page.render({
      canvasContext: pair.context,
      viewport,
      canvasFactory: factory,
    }).promise;
    const png = pair.canvas.toBuffer('image/png');
    return sharp(png).flatten({ background: '#ffffff' }).png().toBuffer();
  } finally {
    await doc.destroy().catch(() => {});
  }
}

function fontName(font, key) {
  const record = font.names?.[key];
  if (!record) return '';
  if (typeof record === 'string') return record;
  return record.en || record['en-US'] || Object.values(record)[0] || '';
}

function wrapLine(font, text, size, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const trial = current ? `${current} ${word}` : word;
    const width = font.getAdvanceWidth(trial, size);
    if (width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = trial;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

async function renderFontSpecimen(filePath) {
  let font;
  try {
    const bytes = fs.readFileSync(filePath);
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    font = opentype.parse(copy);
  } catch (err) {
    throw new Error(`Could not read font (${err.message})`);
  }

  const width = 1240;
  const height = 1754;
  const margin = 80;
  const family = fontName(font, 'fullName') || fontName(font, 'fontFamily') || path.basename(filePath);
  const detail = [fontName(font, 'version'), fontName(font, 'designer'), fontName(font, 'manufacturer')]
    .filter(Boolean)
    .join('  ·  ');

  const blocks = [
    { text: family, size: 58, gap: 16, color: '#1c1917' },
    { text: detail || 'TrueType / OpenType specimen', size: 18, gap: 42, color: '#57534e' },
    { text: 'The quick brown fox jumps over the lazy dog.', size: 36, gap: 22, color: '#1c1917' },
    { text: 'Sphinx of black quartz, judge my vow.', size: 30, gap: 36, color: '#1c1917' },
    { text: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', size: 24, gap: 14, color: '#1c1917' },
    { text: 'abcdefghijklmnopqrstuvwxyz', size: 24, gap: 14, color: '#1c1917' },
    { text: '0123456789  ! @ # $ % & * ( ) [ ] { }', size: 24, gap: 40, color: '#1c1917' },
    {
      text: 'This sheet is the editable page for the font. Crop it, tone it, and combine it with scans or photos in one PDF.',
      size: 18,
      gap: 12,
      color: '#44403c',
    },
  ];

  const paths = [];
  let y = margin + 58;
  for (const block of blocks) {
    const lines = wrapLine(font, block.text, block.size, width - margin * 2);
    for (const line of lines) {
      if (y > height - margin) break;
      const glyph = font.getPath(line, margin, y, block.size);
      glyph.fill = block.color;
      paths.push(glyph.toSVG(2));
      y += Math.round(block.size * 1.28);
    }
    y += block.gap;
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <rect x="40" y="40" width="${width - 80}" height="${height - 80}" fill="none" stroke="#e7e5e4" stroke-width="2"/>
  ${paths.join('\n')}
</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

module.exports = {
  ALLOWED_EXT,
  isAllowed,
  sourceTypeFor,
  inspectFile,
  decodeBase,
};
