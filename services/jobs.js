/**
 * Folder-backed job store. Each job is a directory:
 *   storage/jobs/<timestamp>_<id>/manifest.json
 *   storage/jobs/<timestamp>_<id>/uploads|cache|previews|exports
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', 'storage', 'jobs');
const ID_RE = /^\d{8}_\d{6}_[a-f0-9]{6}$/;

const chains = new Map();

function assertId(id) {
  if (!ID_RE.test(id || '')) {
    throw Object.assign(new Error('Unknown job'), { status: 404 });
  }
  return id;
}

function jobDir(id) {
  assertId(id);
  return path.join(ROOT, id);
}

function manifestPath(id) {
  return path.join(jobDir(id), 'manifest.json');
}

function createJobId() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}_${crypto.randomBytes(3).toString('hex')}`;
}

function createEmptyJob() {
  const id = createJobId();
  const now = new Date().toISOString();
  const dir = path.join(ROOT, id);
  for (const sub of ['uploads', 'cache', 'previews', 'exports']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  const job = { id, createdAt: now, updatedAt: now, notice: null, pages: [] };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(job, null, 2));
  return job;
}

function readJob(id) {
  const file = manifestPath(id);
  if (!fs.existsSync(file)) throw Object.assign(new Error('Job not found'), { status: 404 });
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJob(job) {
  job.updatedAt = new Date().toISOString();
  const file = manifestPath(job.id);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(job, null, 2));
  fs.renameSync(temp, file);
  return job;
}

/** Serialize read-modify-write for one job so previews and edits cannot clobber each other. */
function withJob(id, mutator) {
  assertId(id);
  const previous = chains.get(id) || Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    const job = readJob(id);
    const next = await mutator(job);
    if (next) writeJob(next);
    return readJob(id);
  });
  chains.set(id, run.then(() => {}, () => {}));
  return run;
}

function listJobs(limit = 12) {
  if (!fs.existsSync(ROOT)) return [];
  return fs
    .readdirSync(ROOT)
    .filter((name) => ID_RE.test(name))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((id) => {
      try {
        const job = readJob(id);
        return {
          id: job.id,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
          pages: job.pages.length,
          label: job.pages[0]?.fileName || 'Empty job',
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function deleteJob(id) {
  const dir = jobDir(id);
  if (!fs.existsSync(dir)) throw Object.assign(new Error('Job not found'), { status: 404 });
  fs.rmSync(dir, { recursive: true, force: true });
}

function present(job) {
  return {
    id: job.id,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    notice: job.notice,
    pages: job.pages.map((page, index) => ({
      id: page.id,
      index,
      fileName: page.fileName,
      sourceType: page.sourceType,
      pageIndex: page.pageIndex,
      label: page.label,
      width: page.width,
      height: page.height,
      status: page.status,
      error: page.error,
      revision: page.revision,
      edits: page.edits,
      previewUrl: page.status !== 'error' && (page.status === 'ready' || page.revision > 0)
        ? `/api/jobs/${job.id}/pages/${page.id}/preview?v=${page.revision}`
        : null,
    })),
  };
}

module.exports = {
  ROOT,
  assertId,
  jobDir,
  createEmptyJob,
  readJob,
  withJob,
  listJobs,
  deleteJob,
  present,
};
