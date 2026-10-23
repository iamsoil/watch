import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT_HTTP = 8787;
const PORT_CDP = 9337;

const server = spawn(process.execPath, ['server/server.js'], {
  env: { ...process.env, PORT: String(PORT_HTTP) },
  stdio: 'ignore',
});

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-prof-'));
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
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

async function main() {
  let list = null;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT_CDP + '/json/list');
      list = await r.json();
      if (list?.length) break;
    } catch { /* browser warming */ }
    await sleep(250);
  }
  const target = list.find(t => t.type === 'page');
  if (!target) throw new Error('no page target');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pend.has(msg.id)) {
      const p = pend.get(msg.id);
      pend.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  };

  await rpc('Page.enable');
  await rpc('Runtime.enable');
  await rpc('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  await rpc('Page.navigate', { url: 'http://localhost:' + PORT_HTTP + '/new' });
  await sleep(1600);

  await rpc('Runtime.evaluate', {
    expression: `
      document.getElementById('gate-name').value = 'Vis';
      document.getElementById('gate-form').querySelector('button[type=submit]').click();
      'clicked';
    `,
  });
  await sleep(2200);

  await rpc('Runtime.evaluate', {
    expression: `document.querySelector('#modal-share .x')?.click(); 'modal closed';`,
  });

  const probe1 = await rpc('Runtime.evaluate', {
    expression: `JSON.stringify({
      role: document.body.dataset.role,
      code: document.getElementById('room-code-b').textContent,
      idleShown: !document.getElementById('stage-idle').classList.contains('hidden'),
      sideW: document.getElementById('sidebar').offsetWidth,
      shellW: document.getElementById('player-shell').offsetWidth,
      feed: !!document.getElementById('chat-feed'),
      toast: document.querySelector('.toast')?.textContent || null,
    })`,
    returnByValue: true,
  });
  console.log('ROOM PROBE', probe1.result.value);

  await rpc('Runtime.evaluate', {
    expression: `
      const f = document.getElementById('empty-form');
      f.querySelector('input').value = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
      f.dispatchEvent(new Event('submit', { cancelable: true }));
      'queued';
    `,
  });
  await sleep(5000);

  const probe2 = await rpc('Runtime.evaluate', {
    expression: `JSON.stringify({
      idleShown: !document.getElementById('stage-idle').classList.contains('hidden'),
      cueShown: !document.getElementById('cue').classList.contains('hidden'),
      playerKids: document.getElementById('player').children.length,
      title: document.title,
    })`,
    returnByValue: true,
  });
  console.log('PLAYER PROBE', probe2.result.value);

  await rpc('Runtime.evaluate', {
    expression: `
      document.getElementById('chat-input').value = 'this scene is wild';
      document.getElementById('send-btn').click();
      document.getElementById('btn-emoji').click();
      'chatted';
    `,
  });
  await sleep(900);
  await rpc('Runtime.evaluate', { expression: `document.querySelectorAll('#emoji-panel button')[1]?.click(); 'reacted';` });
  await sleep(1500);

  const shot1 = await rpc('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(process.env.TEMP + '\\watch-room-live.png', Buffer.from(shot1.data, 'base64'));

  await rpc('Runtime.evaluate', { expression: `document.getElementById('cue')?.click(); 'unmuted';` });
  await sleep(900);
  const shot2 = await rpc('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(process.env.TEMP + '\\watch-room-unmuted.png', Buffer.from(shot2.data, 'base64'));

  await rpc('Runtime.evaluate', { expression: `document.querySelector('.player-shell').requestFullscreen().catch(()=>{}); 'fs';` });
  await sleep(1100);
  const probeFs = await rpc('Runtime.evaluate', {
    expression: `JSON.stringify({
      fsActive: !!document.fullscreenElement,
      fsModeClass: document.body.classList.contains('fs-mode'),
      sidebarParent: document.getElementById('sidebar').parentElement.id,
      fabVisible: getComputedStyle(document.getElementById('fs-fab')).display,
      sideVisible: getComputedStyle(document.getElementById('sidebar')).display,
    })`,
    returnByValue: true,
  });
  console.log('FS PROBE', probeFs.result.value);
  await rpc('Runtime.evaluate', { expression: `document.getElementById('fs-fab').click(); 'hud';` });
  await sleep(700);
  const shot3 = await rpc('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(process.env.TEMP + '\\watch-room-fs.png', Buffer.from(shot3.data, 'base64'));

  await rpc('Runtime.evaluate', { expression: `document.exitFullscreen().catch(()=>{}); 'exit';` });
  await sleep(900);
  const probeBack = await rpc('Runtime.evaluate', {
    expression: `JSON.stringify({ sidebarParent: document.getElementById('sidebar').parentElement.className, fsMode: document.body.classList.contains('fs-mode') })`,
    returnByValue: true,
  });
  console.log('EXIT-FS PROBE', probeBack.result.value);

  const mobileShots = await rpc('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  void mobileShots;
  await sleep(700);
  const shot4 = await rpc('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(process.env.TEMP + '\\watch-room-mobile.png', Buffer.from(shot4.data, 'base64'));

  console.log('SCREENSHOTS DONE');
}

main()
  .catch((e) => { console.error('CDP FAIL:', e.message || e); process.exitCode = 1; })
  .finally(() => {
    try { browser.kill(); } catch {}
    try { server.kill(); } catch {}
    setTimeout(() => process.exit(process.exitCode || 0), 400);
  });
