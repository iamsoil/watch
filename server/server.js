import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Hub } from './rooms.js';

const PORT = Number(process.env.PORT || 8787);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', 'dist');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
};

const hub = new Hub();

function sendFile(res, file, status = 200) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(file)
      .on('error', () => { try { res.end(); } catch {} })
      .pipe(res);
  });
}

function serveIndex(res, status = 200) {
  sendFile(res, path.join(DIST, 'index.html'), status);
}

const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    let p = decodeURIComponent(u.pathname || '/');

    if (p === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, rooms: hub.rooms.size, uptime: Math.round(process.uptime()) }));
      return;
    }
    if (p === '/ws') {
      res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('This is the WebSocket endpoint — connect with ws.');
      return;
    }
    if (p === '/' || p.startsWith('/r/') || p === '/new') {
      serveIndex(res);
      return;
    }
    const clean = path.normalize(path.join(DIST, p));
    if (clean !== DIST && !clean.startsWith(DIST + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('forbidden');
      return;
    }
    sendFile(res, clean, 404);
  } catch (e) {
    try {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('server error');
    } catch {}
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  hub.connect(ws);
  ws.on('message', raw => hub.handleMessage(ws, raw.toString()));
  ws.on('close', () => hub.disconnect(ws));
  ws.on('error', () => {});
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);
heartbeat.unref?.();

server.listen(PORT, () => {
  console.log(`WATCH// ready   http://localhost:${PORT}   (rooms live in memory)`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const room of [...hub.rooms.values()]) room.destroyed('Server is starting anew. See you soon.');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 800).unref?.();
  });
}
