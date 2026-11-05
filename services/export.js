/**
 * Builds the downloadable file for a job: one PDF, one multi-page TIFF,
 * a single image, or a zip of per-page files. Output is also written under
 * the job's exports/ folder.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const archiver = require('archiver');
const { PDFDocument } = require('pdf-lib');
const { encodeMultipageTiff } = require('./tiff');

const FORMATS = new Set(['pdf', 'png', 'jpeg', 'webp', 'tiff']);

function parsePageSpec(spec, count) {
  if (!spec || spec === 'all') return null;
  const chosen = new Set();
  for (const part of String(spec).split(',')) {
    const token = part.trim();
    if (!token) continue;
    const range = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      let start = Number(range[1]);
      let end = Number(range[2]);
      if (start > end) [start, end] = [end, start];
      for (let n = start; n <= end; n += 1) chosen.add(n);
    } else if (/^\d+$/.test(token)) {
      chosen.add(Number(token));
    } else {
      throw Object.assign(new Error('Page range must look like 1-3,5'), { status: 400 });
    }
  }
  if (!chosen.size) throw Object.assign(new Error('Pick at least one page'), { status: 400 });
  const indexes = [...chosen].sort((a, b) => a - b);
  for (const n of indexes) {
    if (n < 1 || n > count) {
      throw Object.assign(new Error(`Page ${n} is outside 1–${count}`), { status: 400 });
    }
  }
  return indexes.map((n) => n - 1);
}

function safeStem(name) {
  const stem = String(name || 'ttif')
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[^\w\-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return stem || 'ttif';
}

async function toRgb(pngBuffer) {
  const { data, info } = await sharp(pngBuffer)
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3 || data.length !== info.width * info.height * 3) {
    throw new Error('Could not flatten a page to RGB');
  }
  return { data, width: info.width, height: info.height };
}

async function encodeRaster(pngBuffer, format, quality) {
  const q = Math.min(100, Math.max(40, Number(quality) || 88));
  if (format === 'png') return { buffer: await sharp(pngBuffer).png().toBuffer(), ext: 'png', mime: 'image/png' };
  if (format === 'jpeg') {
    return {
      buffer: await sharp(pngBuffer).jpeg({ quality: q, mozjpeg: true }).toBuffer(),
      ext: 'jpg',
      mime: 'image/jpeg',
    };
  }
  if (format === 'webp') {
    return { buffer: await sharp(pngBuffer).webp({ quality: q }).toBuffer(), ext: 'webp', mime: 'image/webp' };
  }
  if (format === 'tiff') {
    return {
      buffer: await sharp(pngBuffer).tiff({ compression: 'lzw' }).toBuffer(),
      ext: 'tif',
      mime: 'image/tiff',
    };
  }
  throw Object.assign(new Error('Unknown export format'), { status: 400 });
}

async function buildPdf(pngPages, quality) {
  const pdf = await PDFDocument.create();
  const q = Math.min(100, Math.max(40, Number(quality) || 88));
  for (const png of pngPages) {
    const jpeg = await sharp(png).jpeg({ quality: q, mozjpeg: true }).toBuffer();
    const meta = await sharp(jpeg).metadata();
    const image = await pdf.embedJpg(jpeg);
    const landscape = meta.width > meta.height;
    const pageWidth = landscape ? 841.89 : 595.28;
    const pageHeight = landscape ? 595.28 : 841.89;
    const margin = 28;
    const scale = Math.min((pageWidth - margin * 2) / meta.width, (pageHeight - margin * 2) / meta.height);
    const drawWidth = meta.width * scale;
    const drawHeight = meta.height * scale;
    const page = pdf.addPage([pageWidth, pageHeight]);
    page.drawImage(image, {
      x: (pageWidth - drawWidth) / 2,
      y: (pageHeight - drawHeight) / 2,
      width: drawWidth,
      height: drawHeight,
    });
  }
  return Buffer.from(await pdf.save());
}

function zipBuffers(entries) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 6 } });
    const chunks = [];
    archive.on('data', (chunk) => chunks.push(chunk));
    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') reject(err);
    });
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    for (const entry of entries) archive.append(entry.buffer, { name: entry.name });
    archive.finalize();
  });
}

/**
 * pages: [{ label, png }]
 * options: { format, mode, quality, filename }
 */
async function packageExport(pages, options, exportDir) {
  const format = String(options.format || 'pdf').toLowerCase();
  if (!FORMATS.has(format)) throw Object.assign(new Error('Choose pdf, png, jpeg, webp, or tiff'), { status: 400 });
  const mode = options.mode === 'separate' ? 'separate' : 'merge';
  const quality = options.quality;
  const stem = safeStem(options.filename);
  fs.mkdirSync(exportDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
  let buffer;
  let ext;
  let mime;
  let downloadName;

  const mergePdf = format === 'pdf' && mode !== 'separate';
  const mergeTiff = format === 'tiff' && mode !== 'separate';

  if (pages.length === 1 || mergePdf || mergeTiff) {
    if (format === 'pdf') {
      buffer = await buildPdf(pages.map((page) => page.png), quality);
      ext = 'pdf';
      mime = 'application/pdf';
    } else if (format === 'tiff' && pages.length > 1) {
      const rgbPages = [];
      for (const page of pages) rgbPages.push(await toRgb(page.png));
      buffer = encodeMultipageTiff(rgbPages);
      ext = 'tif';
      mime = 'image/tiff';
    } else {
      const encoded = await encodeRaster(pages[0].png, format === 'pdf' ? 'png' : format, quality);
      buffer = encoded.buffer;
      ext = encoded.ext;
      mime = encoded.mime;
    }
    downloadName = `${stem}.${ext}`;
  } else {
    const entries = [];
    for (let i = 0; i < pages.length; i += 1) {
      const page = pages[i];
      const prefix = `${String(i + 1).padStart(3, '0')}-${safeStem(page.label)}`;
      if (format === 'pdf') {
        entries.push({ name: `${prefix}.pdf`, buffer: await buildPdf([page.png], quality) });
      } else {
        const encoded = await encodeRaster(page.png, format, quality);
        entries.push({ name: `${prefix}.${encoded.ext}`, buffer: encoded.buffer });
      }
    }
    buffer = await zipBuffers(entries);
    ext = 'zip';
    mime = 'application/zip';
    downloadName = `${stem}.zip`;
  }

  const storedName = `${stamp}_${downloadName}`;
  const storedPath = path.join(exportDir, storedName);
  await fs.promises.writeFile(storedPath, buffer);
  return { storedPath, downloadName, mime, bytes: buffer.length };
}

module.exports = { parsePageSpec, packageExport, FORMATS };
