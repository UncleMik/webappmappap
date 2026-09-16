const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = __dirname;
const port = Number(process.env.PORT || 5173);
const config = JSON.parse(fs.readFileSync(process.env.WEBPRIL_CONFIG || path.join(root, '../tools/preview-runtime/access.json'), 'utf8'));
if (!config.username || !config.password) throw new Error('Website credentials are not configured');
const expected = crypto.createHash('sha256').update(`Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`).digest();
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ttf': 'font/ttf' };
module.exports = http.createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const received = crypto.createHash('sha256').update(req.headers.authorization || '').digest();
  if (!crypto.timingSafeEqual(expected, received)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="WebPril", charset="UTF-8"' });
    return res.end('Login required');
  }
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); return res.end('Bad request'); }
  if (pathname.includes('\0')) { res.writeHead(400); return res.end('Bad request'); }
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  if (!types[path.extname(file)] || pathname.split(/[\\/]/).some(part => part.startsWith('.'))) {
    res.writeHead(404); return res.end('Not found');
  }
  fs.readFile(file, (error, bytes) => {
    if (error) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  });
}).listen(port, '127.0.0.1', () => console.log(`Сегодня: http://localhost:${port}`));
