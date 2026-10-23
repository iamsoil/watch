import { spawn } from 'node:child_process';

const PORT = Number(process.env.SMOKE_PORT || 8771);
const BASE = 'http://127.0.0.1:' + PORT;
const failures = [];
let passed = 0;

function check(cond, label, extra) {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failures.push(label); console.log('  FAIL ' + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 220) : '')); }
}

class Mini {
  constructor() {
    this.queue = [];
    this.waiters = [];
    this.ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
    this.ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      const w = this.waiters.findIndex(x => x.type === '*' || x.type === m.t);
      if (w >= 0) this.waiters.splice(w, 1)[0].resolve(m);
      else this.queue.push(m);
    };
    this.opened = new Promise((res, rej) => {
      this.ws.onopen = () => res(true);
      this.ws.onerror = () => rej(new Error('ws connect failed'));
    });
    this.closedCode = new Promise((res) => { this.ws.onclose = (ev) => res(ev.code); });
  }
  async open() { await this.opened; }
  send(obj) { try { this.ws.send(JSON.stringify(obj)); } catch {} }
  sendRaw(str) { try { this.ws.send(str); } catch {} }
  reset() { this.queue = []; }
  wait(type, ms = 5000) {
    const i = this.queue.findIndex(m => m.t === type || type === '*');
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting ' + type)), ms);
      this.waiters.push({ type, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  }
}

async function main() {
  const server = spawn(process.execPath, ['server/server.js'], {
    env: { ...process.env, PORT: String(PORT), WATCH_GHOSTS: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', d => process.stdout.write('[srv] ' + d));
  server.stderr.on('data', d => process.stdout.write('[srv!] ' + d));

  let up = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/healthz');
      if (r.ok) { up = true; break; }
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 120));
  }
  check(up, 'server /healthz came up');
  if (!up) return finish(server);

  const h = new Mini(), g = new Mini(), g2 = new Mini();
  await Promise.all([h.open(), g.open(), g2.open()]);
  check(true, '3 websocket clients connected');

  h.send({ t: 'create', name: 'Host' });
  const created = await h.wait('created');
  check(/^[A-Z2-9]{6}$/.test(created.code || ''), 'room code: 6 chars from the safe alphabet', created.code);
  check(created.you.role === 'host', 'creator is host');
  const CODE = created.code;

  g.send({ t: 'join', code: CODE.toLowerCase(), name: '   Mia   ' });
  const joined = await g.wait('joined');
  check(joined.code === CODE, 'join code is case-insensitive');
  check(joined.you.name === 'Mia', 'guest name normalized to "Mia"', joined.you.name);
  check(Array.isArray(joined.viewers) && joined.viewers.length >= 2, 'presence snapshot includes host+guest', joined.viewers);

  h.reset();
  h.send({ t: 'chat', text: 'yo the sync is live' });
  const chat1 = await g.wait('chat', 3000);
  check(chat1.fromName === 'Host' && chat1.text === 'yo the sync is live', 'chat broadcast carries name+text', chat1);

  h.reset();
  h.sendRaw('{@@not json');
  const errBad = await h.wait('error', 2000);
  check(String(errBad.msg || '').includes('Unreadable'), 'bad json gets an explicit error frame', errBad);

  h.reset();
  h.send({ t: 'playback', videoId: 'dQw4w9WgXcQ', state: 'playing', position: 42 });
  const pb = await g.wait('playback', 3000);
  check(pb.videoId === 'dQw4w9WgXcQ' && pb.state === 'playing' && Math.abs(pb.position - 42) < 1, 'playback packet relays video+state+position', pb);

  g.reset();
  h.reset();
  g.send({ t: 'playback', videoId: 'HACKEDhack', state: 'paused', position: 0 });
  const noBounce = await h.wait('playback', 1200).then(() => false).catch(() => true);
  check(noBounce, 'guest playback packets are ignored');

  h.reset();
  h.send({ t: 'playback', videoId: 'qzk_xlryzAm', state: 'paused', position: 9 });
  const pb3 = await g.wait('playback', 2500);
  check(pb3.videoId === 'qzk_xlryzAm', 'host may change the videoId mid-stream', pb3);

  g.reset();
  h.reset();
  g.send({ t: 'reaction', emoji: '🔥' });
  const react = await h.wait('reaction', 2500);
  check(react.emoji === '🔥' && react.fromName === 'Mia', 'reaction propagates with author', react);

  g.reset();
  h.reset();
  g.send({ t: 'gif', id: 'wtn-clap', url: 'https://media.giphy.com/media/DYH297XiCS2Ck/giphy.gif' });
  const gif = await h.wait('gif', 2500);
  check(String(gif.url).includes('giphy.com') && gif.fromName === 'Mia', 'gif event relays url+author', gif);

  h.reset();
  g.send({ t: 'gif', id: 'bad', url: 'http://evil.com/x.gif' });
  const gifBadRejected = await h.wait('gif', 1200).then(() => false).catch(() => true);
  check(gifBadRejected, 'non-https gif urls are refused');

  h.reset();
  h.send({ t: 'gif-search', tag: 'trending' });
  const gsr = await h.wait('gif-search-result', 4000);
  check(Array.isArray(gsr.items) && gsr.items.length > 0, 'gif-search returns a non-empty curated set', gsr.items && gsr.items.length);

  h.reset();
  g2.send({ t: 'join', code: CODE, name: 'Rex' });
  await g2.wait('joined');
  const v3 = await h.wait('viewers', 2500);
  check(v3.viewers.length >= 3, 'viewer snapshot reflects the third viewer', v3.viewers);

  const rexfd = v3.viewers.find(v => v.name === 'Rex');
  check(!!rexfd, 'third viewer is listed as "Rex"');
  if (rexfd) {
    g2.reset();
    h.send({ t: 'moderate', target: rexfd.id, action: 'mute' });
    const mutedYou = await g2.wait('muted-you', 2500);
    check(mutedYou.muted === true, 'moderation mute reaches the target');

    g2.reset();
    h.reset();
    g2.send({ t: 'chat', text: 'hello there' });
    const silentOk = await h.wait('chat', 1500).then(() => false).catch(() => true);
    check(silentOk, 'muted viewer cannot push chat through');

    h.reset();
    g2.reset();
    h.send({ t: 'moderate', target: rexfd.id, action: 'kick' });
    const kicked = await g2.wait('kicked', 2500);
    check(kicked.t === 'kicked', 'kick: victim is notified first');
    const cc = await g2.closedCode;
    check(cc === 4003, 'kick: victim socket closed with 4003', cc);
  }

  g.reset();
  h.reset();
  g.send({ t: 'sync' });
  const syncReq = await h.wait('sync-request', 2500);
  check(syncReq.fromName === 'Mia', 'sync handshake reaches the host with the guest name', syncReq);

  g.reset();
  h.reset();
  h.ws.close(1000);
  const hostGone = await g.wait('presence', 3000);
  check(hostGone.kind === 'host-gone', 'host drop notifies guests (host-gone)', hostGone);
  const hv = await g.wait('viewers', 1500).catch(() => null);
  check(hv ? hv.hostless === true : true, 'room flips hostless after the host leaves');

  const g3 = new Mini();
  await g3.open();
  g3.send({ t: 'join', code: CODE, name: 'Backup' });
  const takeover = await g3.wait('joined', 2500);
  check(takeover.you.role === 'host', 'first joiner of a hostless room takes over as host', takeover.you);

  const h4 = new Mini();
  await h4.open();
  h4.send({ t: 'create', name: 'Fresh' });
  const created2 = await h4.wait('created');
  check(/^[A-Z2-9]{6}$/.test(created2.code || '') && created2.code !== CODE, 'second room allocates a fresh code', created2.code);

  const bad = new Mini();
  await bad.open();
  bad.send({ t: 'join', code: 'ZZZZZZ', name: 'Ghost' });
  const notFound = await bad.wait('error', 2500);
  check(String(notFound.msg || '').includes('not found') || String(notFound.msg || '').includes('Room'), 'unknown code gets a "not found" error', notFound);

  const html = await fetch(BASE + '/r/' + CODE).then(r => r.text());
  check(html.includes('view-home') && html.includes('view-room'), 'GET /r/:code serves the room SPA shell');

  const staticRes = await fetch(BASE + '/fallback/clap.gif');
  check(staticRes.status === 200 && String(staticRes.headers.get('content-type')).includes('image/gif'), 'fallback gif served as image/gif');

  const miss = await fetch(BASE + '/no/such/asset.bin.js');
  check(miss.status === 404, 'unknown asset path 404s (no SPA fallthrough)');

  return finish(server);
}

function finish(server) {
  try { server.kill(); } catch {}
  setTimeout(() => {
    console.log('passed:', passed, '  failed:', failures.length);
    if (failures.length) process.exit(1);
    process.exit(0);
  }, 300);
}

main().catch((e) => {
  console.error('SMOKE CRASH:', e && e.message ? e.message : e);
  process.exit(1);
});
