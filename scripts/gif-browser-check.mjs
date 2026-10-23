import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FALLBACK_DIR = path.resolve(HERE, '..', 'public', 'fallback');

const PALETTE_RGB = [
  '10,10,18', '143,69,255', '242,239,255', '58,43,102',
];

const gifs = fs.readdirSync(FALLBACK_DIR).filter(f => f.endsWith('.gif') && !f.startsWith('__'));
const rows = gifs.map(name => `["${name}", "${FALLBACK_DIR.replace(/\\/g, '/')}/${name}"]`).join(',');
const html = `<!doctype html><html><body id="r">
<script>
const GIFS = [${rows}];
const PAL = new Set([${PALETTE_RGB.map(c => `"${c}"`).join(',')}]);
const out = [];
let done = 0;
function finish() {
  const el = document.createElement('pre');
  el.id = 'report';
  el.textContent = 'REPORT ' + JSON.stringify(out);
  document.body.appendChild(el);
}
for (const [name, url] of GIFS) {
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = 120; c.height = 75;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, 120, 75);
    const d = ctx.getImageData(0, 0, 120, 75).data;
    const uniq = new Set();
    for (let i = 0; i < d.length; i += 16) uniq.add(d[i] + ',' + d[i+1] + ',' + d[i+2]);
    let bad = 0;
    for (const u of uniq) if (!PAL.has(u)) bad++;
    out.push([name, uniq.size, bad]);
    if (++done === GIFS.length) finish();
  };
  img.onerror = () => { out.push([name, 'LOAD-FAIL', 0]); if (++done === GIFS.length) finish(); };
  img.src = 'file:///' + url;
}
</script></body></html>`;

const tmp = path.join(os.tmpdir(), 'watch-gifcheck');
fs.mkdirSync(tmp, { recursive: true });
const htmlPath = path.join(tmp, 'check.html');
fs.writeFileSync(htmlPath, html);

const candidates = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env['PROGRAMFILES(X86)'] + '/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const browser = candidates.find(p => fs.existsSync(p));
if (!browser) {
  console.log('SKIP browser check — no chrome/edge found (roundtrip validation already passed)');
  process.exit(0);
}

const res = spawnSync(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--dump-dom',
  '--virtual-time-budget=6000', '--allow-file-access-from-files',
  'file:///' + htmlPath.replace(/\\/g, '/'),
], { encoding: 'utf8', timeout: 30000, maxBuffer: 41943040 });

const dom = res.stdout || '';
const m = /REPORT (.*)<\/pre>/.exec(dom);
if (!m) {
  console.error('no REPORT in dom output');
  console.error(dom.slice(0, 400));
  process.exit(1);
}
const results = JSON.parse(m[1].replace(/&quot;/g, '"'));
let fail = 0;
for (const [name, uniq, bad] of results) {
  const ok = bad === 0 && uniq >= 2;
  if (!ok) fail++;
  console.log((ok ? 'ok ' : 'BAD') + ` ${name}  uniqColors=${uniq} offPalette=${bad}`);
}
if (fail) process.exit(1);
console.log('browser decode check passed for all fallback gifs');
