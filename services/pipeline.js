/**
 * Job orchestration: ingest uploads, render previews off the request thread,
 * and run exports. Heavy work is queued with a small concurrency cap so the
 * HTTP thread stays free to answer polls.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { inspectFile, decodeBase } = require('./decode');
const { defaultEdits, normalizeEdits, renderEdited } = require('./render');
const { packageExport, parsePageSpec } = require('./export');
const jobs = require('./jobs');

const MAX_PAGES = 120;
const RENDER_SLOTS = 2;

const waiters = [];
let activeRenders = 0;

function schedule(task) {
  return new Promise((resolve, reject) => {
    waiters.push({ task, resolve, reject });
    pump();
  });
}

function pump() {
  while (activeRenders < RENDER_SLOTS && waiters.length) {
    const next = waiters.shift();
    activeRenders += 1;
    Promise.resolve()
      .then(next.task)
      .then(next.resolve, next.reject)
      .finally(() => {
        activeRenders -= 1;
        pump();
      });
  }
}

function pageLabel(fileName, pageIndex, pageCount) {
  if (pageCount > 1) return `${fileName} · ${pageIndex + 1}`;
  return fileName;
}

async function ingestFiles(jobId, files) {
  const created = [];
  const problems = [];

  await jobs.withJob(jobId, async (job) => {
    let remaining = MAX_PAGES - job.pages.length;
    for (const file of files) {
      if (remaining <= 0) {
        problems.push(`${file.originalName}: the ${MAX_PAGES}-page limit was reached`);
        continue;
      }
      try {
        const info = await inspectFile(file.path, file.originalName);
        const count = Math.min(info.pageCount, remaining);
        if (count < info.pageCount) {
          problems.push(`${file.originalName}: imported ${count} of ${info.pageCount} pages`);
        }
        for (let index = 0; index < count; index += 1) {
          const id = `p${crypto.randomBytes(4).toString('hex')}`;
          job.pages.push({
            id,
            fileName: file.originalName,
            storedName: path.basename(file.path),
            sourceType: info.sourceType,
            pageIndex: index,
            label: pageLabel(file.originalName, index, info.pageCount),
            width: null,
            height: null,
            status: 'processing',
            error: null,
            revision: 0,
            renderToken: 1,
            edits: defaultEdits(),
          });
          created.push(id);
        }
        remaining -= count;
      } catch (err) {
        problems.push(`${file.originalName}: ${err.message}`);
      }
    }
    if (problems.length) job.notice = problems.join(' ');
    return job;
  });

  for (const pageId of created) {
    schedule(() => renderPage(jobId, pageId)).catch((err) => {
      console.error(`Preview failed for ${pageId}:`, err.message);
    });
  }

  const job = jobs.readJob(jobId);
  if (!created.length) {
    throw Object.assign(new Error(problems.join(' ') || 'No usable files were uploaded'), { status: 400 });
  }
  return job;
}

async function renderPage(jobId, pageId) {
  const snapshot = jobs.readJob(jobId);
  const page = snapshot.pages.find((item) => item.id === pageId);
  if (!page) return;
  const token = page.renderToken;
  const source = path.join(jobs.jobDir(jobId), 'uploads', path.basename(page.storedName));
  const cachePath = path.join(jobs.jobDir(jobId), 'cache', `${page.id}.png`);

  try {
    if (!fs.existsSync(cachePath)) {
      const png = await decodeBase(source, page);
      await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.promises.writeFile(cachePath, png);
    }
    const meta = await sharp(cachePath).metadata();
    const preview = await renderEdited(cachePath, page.edits, { maxWidth: 1100 });
    const previewPath = path.join(jobs.jobDir(jobId), 'previews', `${page.id}.webp`);
    const tempPath = `${previewPath}.${token}.tmp`;
    await fs.promises.writeFile(tempPath, preview);

    await jobs.withJob(jobId, (job) => {
      const current = job.pages.find((item) => item.id === pageId);
      if (!current || current.renderToken !== token) {
        fs.rmSync(tempPath, { force: true });
        return job;
      }
      fs.renameSync(tempPath, previewPath);
      current.status = 'ready';
      current.error = null;
      current.width = meta.width;
      current.height = meta.height;
      current.revision += 1;
      return job;
    });
  } catch (err) {
    await jobs.withJob(jobId, (job) => {
      const current = job.pages.find((item) => item.id === pageId);
      if (!current || current.renderToken !== token) return job;
      current.status = 'error';
      current.error = err.message;
      current.revision += 1;
      return job;
    });
  }
}

async function updatePage(jobId, pageId, body) {
  const job = await jobs.withJob(jobId, (current) => {
    const page = current.pages.find((item) => item.id === pageId);
    if (!page) throw Object.assign(new Error('Page not found'), { status: 404 });
    page.edits = normalizeEdits({ ...page.edits, ...body, annotations: body.annotations ?? page.edits.annotations });
    if (body.crop === null) page.edits.crop = null;
    page.edits = normalizeEdits(page.edits);
    page.status = 'processing';
    page.renderToken += 1;
    return current;
  });
  schedule(() => renderPage(jobId, pageId)).catch(() => {});
  return job;
}

async function reorderPages(jobId, order) {
  if (!Array.isArray(order)) throw Object.assign(new Error('Order must be a list of page ids'), { status: 400 });
  return jobs.withJob(jobId, (job) => {
    const byId = new Map(job.pages.map((page) => [page.id, page]));
    if (order.length !== job.pages.length || order.some((id) => !byId.has(id)) || new Set(order).size !== order.length) {
      throw Object.assign(new Error('Order must include every page once'), { status: 400 });
    }
    job.pages = order.map((id) => byId.get(id));
    return job;
  });
}

async function removePage(jobId, pageId) {
  return jobs.withJob(jobId, (job) => {
    const page = job.pages.find((item) => item.id === pageId);
    if (!page) throw Object.assign(new Error('Page not found'), { status: 404 });
    job.pages = job.pages.filter((item) => item.id !== pageId);
    for (const file of [
      path.join(jobs.jobDir(jobId), 'cache', `${pageId}.png`),
      path.join(jobs.jobDir(jobId), 'previews', `${pageId}.webp`),
    ]) {
      fs.rmSync(file, { force: true });
    }
    return job;
  });
}

async function previewBuffer(jobId, pageId, { frame = false } = {}) {
  const job = jobs.readJob(jobId);
  const page = job.pages.find((item) => item.id === pageId);
  if (!page) throw Object.assign(new Error('Page not found'), { status: 404 });
  if (!frame) {
    const stored = path.join(jobs.jobDir(jobId), 'previews', `${pageId}.webp`);
    if (page.status !== 'error' && fs.existsSync(stored)) {
      return { buffer: await fs.promises.readFile(stored), type: 'image/webp' };
    }
    throw Object.assign(new Error(page.error || 'Preview is not ready'), { status: 409 });
  }
  const cachePath = await ensureCache(jobId, page);
  const buffer = await renderEdited(cachePath, page.edits, {
    maxWidth: 1400,
    skipCrop: true,
    skipAnnotations: true,
  });
  return { buffer, type: 'image/webp' };
}

async function downloadBuffer(jobId, pageId) {
  const job = jobs.readJob(jobId);
  const page = job.pages.find((item) => item.id === pageId);
  if (!page) throw Object.assign(new Error('Page not found'), { status: 404 });
  const cachePath = await ensureCache(jobId, page);
  const buffer = await renderEdited(cachePath, page.edits);
  return { buffer, filename: `${page.label.replace(/[^\w.\- ]+/g, '_')}.png` };
}

async function ensureCache(jobId, page) {
  const cachePath = path.join(jobs.jobDir(jobId), 'cache', `${page.id}.png`);
  if (!fs.existsSync(cachePath)) {
    const source = path.join(jobs.jobDir(jobId), 'uploads', path.basename(page.storedName));
    const png = await decodeBase(source, page);
    await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.promises.writeFile(cachePath, png);
  }
  return cachePath;
}

async function exportJob(jobId, options) {
  const job = jobs.readJob(jobId);
  if (!job.pages.length) throw Object.assign(new Error('Add a page before exporting'), { status: 400 });
  const indexes = parsePageSpec(options.pages, job.pages.length);
  const selected = indexes ? indexes.map((index) => job.pages[index]) : job.pages.slice();
  const blocked = selected.filter((page) => page.status === 'error');
  if (blocked.length) {
    throw Object.assign(new Error(`${blocked[0].label}: ${blocked[0].error}`), { status: 400 });
  }

  const watermark = options.watermark?.text
    ? { text: String(options.watermark.text).slice(0, 80), opacity: Number(options.watermark.opacity) || 0.16 }
    : null;

  const rendered = [];
  for (const page of selected) {
    if (page.status === 'processing') {
      await renderPage(jobId, page.id);
    }
    const fresh = jobs.readJob(jobId).pages.find((item) => item.id === page.id);
    if (!fresh || fresh.status === 'error') {
      throw Object.assign(new Error(fresh?.error || `Could not render ${page.label}`), { status: 400 });
    }
    const cachePath = await ensureCache(jobId, fresh);
    const png = await renderEdited(cachePath, fresh.edits, { watermark });
    rendered.push({ label: fresh.label, png });
  }

  return packageExport(rendered, options, path.join(jobs.jobDir(jobId), 'exports'));
}

module.exports = {
  MAX_PAGES,
  ingestFiles,
  updatePage,
  reorderPages,
  removePage,
  previewBuffer,
  downloadBuffer,
  exportJob,
};
