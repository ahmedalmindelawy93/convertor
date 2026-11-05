/**
 * Applies crop, rotation, tone, notes, and an optional watermark to a base PNG.
 * Geometry is normalized (0–1) so the browser and the exporter share one model:
 * rotate, then brightness/contrast/grayscale, then crop, then notes, then watermark.
 */

const path = require('path');
const sharp = require('sharp');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');

const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
const sansPath = path.join(pdfjsRoot, 'standard_fonts', 'LiberationSans-Regular.ttf');
const sansBoldPath = path.join(pdfjsRoot, 'standard_fonts', 'LiberationSans-Bold.ttf');

let fontsReady = false;
function ensureFonts() {
  if (fontsReady) return;
  GlobalFonts.registerFromPath(sansPath, 'TTIF Sans');
  GlobalFonts.registerFromPath(sansBoldPath, 'TTIF Sans Bold');
  fontsReady = true;
}

function defaultEdits() {
  return {
    rotation: 0,
    crop: null,
    brightness: 0,
    contrast: 0,
    grayscale: false,
    annotations: [],
  };
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function normalizeEdits(input = {}) {
  const rotation = [0, 90, 180, 270].includes(Number(input.rotation)) ? Number(input.rotation) : 0;
  let crop = null;
  if (input.crop) {
    const x = clamp(input.crop.x, 0, 1);
    const y = clamp(input.crop.y, 0, 1);
    const w = clamp(input.crop.w, 0.01, 1);
    const h = clamp(input.crop.h, 0.01, 1);
    crop = {
      x,
      y,
      w: Math.min(w, 1 - x),
      h: Math.min(h, 1 - y),
    };
  }
  const annotations = Array.isArray(input.annotations)
    ? input.annotations.slice(0, 24).map((note) => ({
        id: String(note.id || '').slice(0, 24),
        text: String(note.text || '').slice(0, 180),
        x: clamp(note.x, 0, 1),
        y: clamp(note.y, 0, 1),
        size: clamp(note.size ?? 3.2, 1.2, 10),
        color: /^#[0-9a-fA-F]{6}$/.test(note.color || '') ? note.color : '#1c1917',
      })).filter((note) => note.text.trim())
    : [];

  return {
    rotation,
    crop,
    brightness: clamp(input.brightness ?? 0, -100, 100),
    contrast: clamp(input.contrast ?? 0, -100, 100),
    grayscale: Boolean(input.grayscale),
    annotations,
  };
}

function extractRect(crop, width, height) {
  let left = Math.round(crop.x * width);
  let top = Math.round(crop.y * height);
  let rectWidth = Math.round(crop.w * width);
  let rectHeight = Math.round(crop.h * height);
  if (left < 0) left = 0;
  if (top < 0) top = 0;
  if (left + rectWidth > width) rectWidth = width - left;
  if (top + rectHeight > height) rectHeight = height - top;
  if (rectWidth < 1 || rectHeight < 1) throw new Error('Crop area is empty');
  return { left, top, width: rectWidth, height: rectHeight };
}

async function renderEdited(basePath, edits, options = {}) {
  const normalized = normalizeEdits(edits);
  const baseMeta = await sharp(basePath).metadata();
  let width = baseMeta.width;
  let height = baseMeta.height;
  if (normalized.rotation === 90 || normalized.rotation === 270) {
    width = baseMeta.height;
    height = baseMeta.width;
  }

  let pipeline = sharp(basePath);
  if (normalized.rotation) {
    pipeline = pipeline.rotate(normalized.rotation, { background: { r: 255, g: 255, b: 255, alpha: 1 } });
  }

  const brightness = Math.min(3, Math.max(0, 1 + normalized.brightness / 100));
  if (Math.abs(brightness - 1) > 0.001) {
    pipeline = pipeline.modulate({ brightness: Math.max(0.001, brightness) });
  }
  const contrast = 1 + normalized.contrast / 100;
  if (Math.abs(contrast - 1) > 0.001) {
    pipeline = pipeline.linear(contrast, 128 * (1 - contrast));
  }
  if (normalized.grayscale) pipeline = pipeline.grayscale();
  if (!options.skipCrop && normalized.crop) {
    pipeline = pipeline.extract(extractRect(normalized.crop, width, height));
  }

  let buffer = await pipeline.png().toBuffer();
  const notes = options.skipAnnotations ? [] : normalized.annotations;
  if (notes.length || options.watermark?.text) {
    buffer = await paintOverlay(buffer, notes, options.watermark);
  }
  if (options.maxWidth) {
    buffer = await sharp(buffer)
      .resize({ width: options.maxWidth, withoutEnlargement: true })
      .webp({ quality: options.previewQuality || 82 })
      .toBuffer();
  }
  return buffer;
}

async function paintOverlay(pngBuffer, annotations, watermark) {
  ensureFonts();
  const image = await loadImage(pngBuffer);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);

  for (const note of annotations) {
    const size = Math.max(12, Math.round((note.size / 100) * image.width));
    ctx.font = `${size}px "TTIF Sans"`;
    ctx.fillStyle = note.color;
    ctx.textBaseline = 'top';
    ctx.fillText(note.text, note.x * image.width, note.y * image.height);
  }

  if (watermark?.text) {
    const opacity = clamp(watermark.opacity ?? 0.16, 0.05, 0.55);
    ctx.save();
    ctx.translate(image.width / 2, image.height / 2);
    ctx.rotate((-32 * Math.PI) / 180);
    ctx.globalAlpha = opacity;
    ctx.fillStyle = '#44403c';
    ctx.font = `700 ${Math.round(image.width * 0.072)}px "TTIF Sans Bold"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(watermark.text).slice(0, 80), 0, 0);
    ctx.restore();
  }

  return canvas.toBuffer('image/png');
}

module.exports = { defaultEdits, normalizeEdits, renderEdited };
