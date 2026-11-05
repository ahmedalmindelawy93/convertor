/**
 * HTTP API for uploads, page edits, previews, and exports.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const jobs = require('../services/jobs');
const pipeline = require('../services/pipeline');
const { isAllowed } = require('../services/decode');
const { timed } = require('../services/logger');

const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      try {
        const dir = path.join(jobs.jobDir(req.jobId), 'uploads');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      } catch (err) {
        cb(err);
      }
    },
    filename(req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase().slice(0, 8);
      const base = path
        .basename(file.originalname, path.extname(file.originalname))
        .replace(/[^\w\-]+/g, '_')
        .slice(0, 48) || 'file';
      cb(null, `${Date.now()}_${Math.random().toString(16).slice(2, 8)}_${base}${ext}`);
    },
  }),
  limits: { fileSize: 250 * 1024 * 1024, files: 40 },
  fileFilter(req, file, cb) {
    if (isAllowed(decodeName(file.originalname))) cb(null, true);
    else cb(Object.assign(new Error(`Unsupported format: ${path.extname(file.originalname) || 'unknown'}`), { status: 400 }));
  },
});

function decodeName(name) {
  const utf = Buffer.from(name, 'latin1').toString('utf8');
  return utf.includes('\uFFFD') ? name : utf;
}

function beginJob(req, res, next) {
  try {
    if (req.params.id) {
      jobs.assertId(req.params.id);
      jobs.readJob(req.params.id);
      req.jobId = req.params.id;
      req.jobWasNew = false;
    } else {
      req.jobId = jobs.createEmptyJob().id;
      req.jobWasNew = true;
    }
    next();
  } catch (err) {
    next(err);
  }
}

function receiveFiles(req, res, next) {
  upload.array('files', 40)(req, res, (err) => {
    if (err && req.jobWasNew) fs.rmSync(jobs.jobDir(req.jobId), { recursive: true, force: true });
    if (err) {
      err.status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400);
      next(err);
      return;
    }
    next();
  });
}

router.get('/health', (req, res) => {
  res.json({ ok: true });
});

router.get('/jobs', (req, res) => {
  res.json({ jobs: jobs.listJobs(15) });
});

router.post('/jobs', beginJob, receiveFiles, async (req, res, next) => {
  try {
    const names = (req.files || []).map((file) => decodeName(file.originalname));
    const job = await timed(req, 'upload', names.join(', ') || 'none', async () => {
      if (!req.files?.length) throw Object.assign(new Error('Choose at least one file'), { status: 400 });
      return pipeline.ingestFiles(
        req.jobId,
        req.files.map((file) => ({ path: file.path, originalName: decodeName(file.originalname) }))
      );
    });
    res.status(201).json({ job: jobs.present(job) });
  } catch (err) {
    if (req.jobWasNew) {
      try {
        if (!jobs.readJob(req.jobId).pages.length) fs.rmSync(jobs.jobDir(req.jobId), { recursive: true, force: true });
      } catch {
        /* job already removed */
      }
    }
    next(err);
  }
});

router.get('/jobs/:id', (req, res, next) => {
  try {
    res.json({ job: jobs.present(jobs.readJob(req.params.id)) });
  } catch (err) {
    next(err);
  }
});

router.delete('/jobs/:id', async (req, res, next) => {
  try {
    await timed(req, 'delete-job', req.params.id, async () => {
      jobs.deleteJob(req.params.id);
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/jobs/:id/files', beginJob, receiveFiles, async (req, res, next) => {
  try {
    const names = (req.files || []).map((file) => decodeName(file.originalname));
    const job = await timed(req, 'upload', names.join(', ') || 'none', async () => {
      if (!req.files?.length) throw Object.assign(new Error('Choose at least one file'), { status: 400 });
      return pipeline.ingestFiles(
        req.jobId,
        req.files.map((file) => ({ path: file.path, originalName: decodeName(file.originalname) }))
      );
    });
    res.json({ job: jobs.present(job) });
  } catch (err) {
    next(err);
  }
});

router.patch('/jobs/:id/pages/:pageId', async (req, res, next) => {
  try {
    const job = await timed(req, 'edit', req.params.pageId, () =>
      pipeline.updatePage(req.params.id, req.params.pageId, req.body || {})
    );
    res.json({ job: jobs.present(job) });
  } catch (err) {
    next(err);
  }
});

router.delete('/jobs/:id/pages/:pageId', async (req, res, next) => {
  try {
    const job = await timed(req, 'delete-page', req.params.pageId, () =>
      pipeline.removePage(req.params.id, req.params.pageId)
    );
    res.json({ job: jobs.present(job) });
  } catch (err) {
    next(err);
  }
});

router.put('/jobs/:id/order', async (req, res, next) => {
  try {
    const job = await timed(req, 'reorder', req.params.id, () => pipeline.reorderPages(req.params.id, req.body?.order));
    res.json({ job: jobs.present(job) });
  } catch (err) {
    next(err);
  }
});

router.get('/jobs/:id/pages/:pageId/preview', async (req, res, next) => {
  try {
    const { buffer, type } = await pipeline.previewBuffer(req.params.id, req.params.pageId, {
      frame: req.query.view === 'frame',
    });
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.end(buffer);
  } catch (err) {
    next(err);
  }
});

router.get('/jobs/:id/pages/:pageId/download', async (req, res, next) => {
  try {
    const { buffer, filename } = await timed(req, 'download-preview', req.params.pageId, () =>
      pipeline.downloadBuffer(req.params.id, req.params.pageId)
    );
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', contentDisposition(filename));
    res.end(buffer);
  } catch (err) {
    next(err);
  }
});

router.post('/jobs/:id/export', async (req, res, next) => {
  try {
    const body = req.body || {};
    const result = await timed(req, `conversion:${body.format || 'pdf'}`, body.filename || req.params.id, () =>
      pipeline.exportJob(req.params.id, body)
    );
    res.setHeader('Content-Type', result.mime);
    res.setHeader('Content-Disposition', contentDisposition(result.downloadName));
    fs.createReadStream(result.storedPath).pipe(res);
  } catch (err) {
    next(err);
  }
});

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

module.exports = router;
