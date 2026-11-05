/**
 * Format Converter server.
 * Binds to HOST/PORT (default 0.0.0.0:3000) so other machines on the LAN can reach it.
 * Files live under ./storage — there is no database.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const express = require('express');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('PORT must be an integer between 1 and 65535.');
  process.exit(1);
}

for (const dir of ['storage/jobs', 'storage/logs']) {
  fs.mkdirSync(path.join(__dirname, dir), { recursive: true });
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.use(
  express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
    index: 'index.html',
  })
);

app.use('/api', require('./routes/api'));

app.use((err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : err.code === 'LIMIT_FILE_COUNT' ? 400 : 400);
  console.error(err);
  res.status(status).json({ error: err.message || 'Request failed' });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Format Converter is listening on http://${HOST}:${PORT}`);
  if (HOST === '0.0.0.0' || HOST === '::') {
    const urls = lanUrls(PORT);
    if (urls.length) {
      console.log('On this network, open:');
      for (const url of urls) console.log(`  ${url}`);
    }
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Set PORT to a free port and start again.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

function lanUrls(port) {
  const urls = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) urls.push(`http://${entry.address}:${port}`);
    }
  }
  return urls;
}
