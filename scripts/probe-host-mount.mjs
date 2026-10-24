// Regression probe: the HOST must mount its own player when the server echoes a
// NEW videoId (set-video), and must NOT re-apply transport state for the video it
// already owns (echo-break stays in place).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT_HTTP = 8791;
const PORT_CDP = 9351;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const server = spawn(process.execPath, ['server/server.js'], {
  env: { ...process.env, PORT: String(PORT_HTTP), WATCH_GHOSTS: 'off' },
  stdio: 'ignore',
});
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-hostmount-'));
const browser = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=' + PORT_CDP,
  '--user-data-dir=' + profile,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let ws, idc = 0;
const pend = new Map();
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++idc;
    pend.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function ev(expr) {
  const r = await rpc('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails) throw new Error('PAGE JS: ' + (r.exceptionDetails.text || ''));
  return r.result?.value;
}

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
}

async function main() {
  let list = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT_CDP + '/json/list');
      list = await r.json();
      if (list?.length) break;
    } catch { /* warming */ }
    await sleep(250);
  }
  const target = list.find(t => t.type === 'page');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id); pend.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    }
  };
  await rpc('Page.enable'); await rpc('Runtime.enable');

  await rpc('Page.navigate', { url: 'http://localhost:' + PORT_HTTP + '/new' });
  await sleep(1800);
  await ev(`document.getElementById('gate-name').value='HostBob'; document.getElementById('gate-form').querySelector('button[type=submit]').click(); 'ok'`);
  await sleep(2200);
  await ev(`document.getElementById('share-close').click(); 'ok'`);

  // --- Case 1: first video via set-video -> host must mount its own player
  await ev(`const f=document.getElementById('empty-form'); f.querySelector('input').value='https://www.youtube.com/watch?v=dQw4w9WgXcQ'; f.dispatchEvent(new Event('submit',{cancelable:true})); 'ok'`);
  await sleep(6000);

  const c1 = await ev(`JSON.stringify({
    idleShown: !document.getElementById('stage-idle').classList.contains('hidden'),
    hasYt: !!window.__watchYt,
    iframes: document.querySelectorAll('#player-shell iframe').length,
    msgLog: (window.__msgLog || []).slice(-6),
  })`);
  const s1 = JSON.parse(c1);
  check('host mounts its own player after set-video echo', !s1.idleShown && s1.hasYt && s1.iframes > 0, s1);
  check('host received the playback echo for the new videoId',
    (s1.msgLog || []).some(x => x.startsWith('playback:') && x.includes('dQw4w9WgXcQ')), s1.msgLog);

  // --- Case 2: same videoId echoed again must NOT re-apply transport state
  const before = await ev(`(function(){const yt=window.__watchYt; return JSON.stringify({state:yt.getPlayerState(),t:yt.getCurrentTime()});})()`);
  await ev(`window.__watchEchoCount=0; (function(){const orig=window.__watchYt; })(); 'ok'`);
  // Force a server echo of the SAME videoId by asking the server to rebroadcast:
  // the host's own heartbeat emits playback, server broadcasts it back.
  await sleep(3000);
  const after = await ev(`(function(){const yt=window.__watchYt; return JSON.stringify({state:yt.getPlayerState(),t:yt.getCurrentTime()});})()`);
  const b = JSON.parse(before), a = JSON.parse(after);
  const drift = Math.abs((a.t || 0) - (b.t || 0));
  check('host echo of same videoId does not remount/reload the player',
    drift < 4 && a.state !== 5, { before: b, after: a });

  // --- Case 3: a NEW videoId must mount again (host can switch reels)
  await ev(`document.getElementById('ctl-video').click(); 'ok'`);
  await sleep(400);
  await ev(`(()=>{const f=document.getElementById('video-form'); f.querySelector('input').value='qzk_xlryzAm'; f.dispatchEvent(new Event('submit',{cancelable:true})); return 'ok';})()`);
  await sleep(6000);
  const c3 = await ev(`JSON.stringify({
    idleShown: !document.getElementById('stage-idle').classList.contains('hidden'),
    msgLog: (window.__msgLog || []).slice(-6),
    videoData: (function(){try{return window.__watchYt.getVideoData().video_id;}catch(e){return 'ERR';}})(),
  })`);
  const s3 = JSON.parse(c3);
  check('host mounts a newly chosen videoId', !s3.idleShown && s3.videoData === 'qzk_xlryzAm', s3);

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) process.exitCode = 1;
}

main().catch(e => { console.error('PROBE FAIL:', e.message || e); process.exitCode = 1; })
  .finally(() => {
    try { browser.kill(); } catch { }
    try { server.kill(); } catch { }
    setTimeout(() => process.exit(process.exitCode || 0), 400);
  });
