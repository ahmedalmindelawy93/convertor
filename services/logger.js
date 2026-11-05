/**
 * Plain-text audit log.
 * One line per action, appended to ./storage/logs/activity.log and echoed to the console.
 *
 * [YYYY-MM-DD HH:mm:ss] | IP: <user_ip> | User-Agent: <agent> | Action: <conversion/edit> | File: <filename> | Time Consumed: <Xms>
 */

const fs = require('fs');
const path = require('path');

const logFile = path.join(__dirname, '..', 'storage', 'logs', 'activity.log');

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

function field(value) {
  const text = String(value ?? 'unknown').replace(/[\r\n|]+/g, ' ').trim();
  return (text || 'unknown').slice(0, 400);
}

function isLoopback(address) {
  const value = String(address || '').toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function clientIp(req) {
  const remote = req?.socket?.remoteAddress || req?.ip || 'unknown';
  if (process.env.TRUST_PROXY === '1' && isLoopback(remote)) {
    const forwarded = String(req?.headers?.['x-forwarded-for'] || '');
    const hops = forwarded.split(',').map((part) => part.trim()).filter(Boolean);
    const client = hops[hops.length - 1];
    if (client) return client.replace(/^::ffff:/i, '');
  }
  return remote;
}

function logActivity({ req, action, file, ms }) {
  const line = `[${stamp()}] | IP: ${field(clientIp(req))} | User-Agent: ${field(req?.headers?.['user-agent'])} | Action: ${field(action)} | File: ${field(file)} | Time Consumed: ${Math.max(0, Number(ms) || 0)}ms`;
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, `${line}\n`);
  console.log(line);
}

/** Run fn and always write a timing line, including when fn throws. */
async function timed(req, action, file, fn) {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    logActivity({ req, action, file, ms: Date.now() - started });
  }
}

module.exports = { logActivity, timed, clientIp, logFile };
