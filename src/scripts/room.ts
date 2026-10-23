import { Conn, AnyMsg } from './ws';
import * as O from './overlays';

interface Viewer { id: string; name: string; role: string; muted: boolean; ghost: boolean }
interface Playback { videoId: string | null; state: 'empty' | 'playing' | 'paused'; position: number; at: number; changed?: boolean }

const byId = (id: string) => document.getElementById(id) as HTMLElement;
const qx = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const EMOJIS = ['😂', '🔥', '💖', '😱', '👏', '😲', '🤯', '😢', '🎬', '🍿', '👀', '💀', '😍', '🥳', '🫡', '🤔'];
const GIF_TAGS = ['trending', 'hype', 'lol', 'wow', 'clap', 'popcorn', 'love', 'nope', 'shock', 'facepalm'];

let conn: Conn | null = null;
let role: 'host' | 'guest' = 'guest';
let me: Viewer = { id: '', name: '', role: 'guest', muted: false, ghost: false };
let roomCode = '';
let lastPlayback: Playback | null = null;
let yt: any = null;
let mountedVideoId: string | null = null;
let userUnmuted = false;
let heartbeat: number | null = null;
let uiClock: number | null = null;
let viewers: Viewer[] = [];
let hostless = true;
let deadSoon = false;
let soleSlugName: string | null = null;

function expectedPosition(p: Playback): number {
  if (p.state !== 'playing') return p.position;
  return p.position + Math.max(0, (Date.now() - p.at) / 1000);
}
function safeTime(): number {
  try { return yt?.getCurrentTime?.() || 0; } catch { return 0; }
}
function safeState(): number {
  try { return yt?.getPlayerState?.() ?? -1; } catch { return -1; }
}
function fmt(t: number): string {
  t = Math.max(0, Math.floor(t));
  const m = Math.floor(t / 60), s = t % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}
function toast(msg: string, kind: '' | 'violet' | 'warn' = '') {
  const box = byId('toasts');
  const tEl = document.createElement('div');
  tEl.className = 'toast' + (kind ? ' ' + kind : '');
  tEl.innerHTML = '<span class="t-dot">◈</span><span></span>';
  (tEl.lastElementChild as HTMLElement).textContent = msg;
  box.appendChild(tEl);
  window.setTimeout(() => tEl.remove(), 3800);
  if (box.children.length > 4) box.firstElementChild?.remove();
}
function connBanner(on: boolean, text = 'CONNECTING…') {
  const b = byId('conn-banner');
  b.textContent = text;
  b.classList.toggle('on', on);
}

export function parseYtId(input: string): string | null {
  const s = String(input || '').trim();
  let m = /(?:v=|youtu\.be\/|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})/.exec(s);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  return null;
}

export function initRoom(mode: 'create' | 'join', name: string, code: string) {
  document.body.dataset.role = 'guest';
  conn = new Conn();
  conn.onOpen = () => {
    conn?.send(mode === 'create' ? { t: 'create', name } : { t: 'join', code, name });
  };
  conn.onMsg = onMessage;
  conn.onClose = (retry) => {
    if (deadSoon) return;
    connBanner(retry, 'RECONNECTING TO THE ROOM…');
  };
  conn.connect();

  buildComposer();
  buildEmojiPanel();
  buildGifTags('trending');
  document.getElementById('chat-feed')!.textContent = '';

  heartbeat = window.setInterval(heartbeatTick, 2500);
  uiClock = window.setInterval(uiTick, 500);
}

function leavePage(msg: string) {
  deadSoon = true;
  conn?.stop();
  connBanner(false);
  toast(msg, 'warn');
  window.setTimeout(() => { window.location.href = '/'; }, 1600);
}

function onMessage(m: AnyMsg) {
  switch (m.t) {
    case 'created':
    case 'joined': {
      connBanner(false);
      role = m.you.role === 'host' ? 'host' : 'guest';
      me = m.you;
      roomCode = m.code;
      document.body.dataset.role = role;
      viewers = m.viewers || [];
      hostless = !!m.hostless;
      byId('room-code-b').textContent = '#' + roomCode;
      const link = window.location.origin + '/r/' + roomCode;
      (byId('share-link') as HTMLInputElement).value = link;
      byId('share-code').textContent = roomCode;
      if (m.t === 'joined') {
        renderHistory(m.history || []);
        window.history.replaceState(null, '', '/r/' + roomCode);
        toast('You are in room #' + roomCode, 'violet');
      } else {
        addSys('Room born. Paste a video and share the code.');
        window.history.replaceState(null, '', '/r/' + roomCode);
        window.setTimeout(() => openModal('modal-share'), 600);
      }
      byId('viewers-box')!.textContent = '';
      const h = document.createElement('h4');
      h.textContent = 'VIEWERS';
      byId('viewers-box').appendChild(h);
      const list = document.createElement('div');
      list.id = 'viewers-list';
      byId('viewers-box').appendChild(list);
      renderViewers();
      applyPlaybackState(m.playback);
      if (m.t === 'joined') conn?.send({ t: 'sync' });
      break;
    }
    case 'viewers': {
      viewers = m.viewers || [];
      hostless = !!m.hostless;
      renderViewers();
      break;
    }
    case 'presence': {
      let line = '';
      if (m.kind === 'joined') { line = m.name + ' joined.'; toast(line, 'violet'); }
      else if (m.kind === 'left') line = m.name + ' left.';
      else if (m.kind === 'kicked') { line = m.name + ' was removed · '; toast(String(m.name) + ' got removed', 'warn'); }
      else if (m.kind === 'host-gone') { toast('Host stepped away — playback is paused', 'warn'); line = 'The host stepped away. First joiner can take the deck.'; }
      else if (m.kind === 'host-back') { toast(String(m.name) + ' takes over as host', 'violet'); line = String(m.name) + ' took the deck as host.'; }
      else if (m.kind === 'muted') { line = m.name + ' was muted'; toast(String(m.name) + ' was muted', 'warn'); }
      else if (m.kind === 'unmuted') line = m.name + ' can talk again.';
      if (line) addSys(line);
      break;
    }
    case 'chat': {
      addChatLine(m.fromName, m.text, m.fromId, false);
      O.spawnMessage(m.fromName, m.text);
      soleSlugName = m.fromName;
      O.setSlug(m.fromName, m.text);
      break;
    }
    case 'gif': {
      addGifLine(m.fromName, m.url, m.fromId, false);
      O.spawnGif(m.url);
      soleSlugName = m.fromName;
      O.setSlug(m.fromName, 'floated a GIF');
      break;
    }
    case 'reaction': {
      addReactLine(m.fromName, m.emoji, false);
      O.spawnReaction(m.emoji);
      tickerAdd(m.emoji);
      break;
    }
    case 'playback': {
      applyPlaybackState(m as unknown as Playback);
      break;
    }
    case 'sync-request':
      if (role === 'host') { emitPlayback(); toast((m.fromName || 'Someone') + ' wants a sync'); }
      break;
    case 'muted-you': {
      me.muted = !!m.muted;
      (byId('chat-input') as HTMLInputElement).disabled = me.muted;
      if (me.muted) toast('The host muted you', 'warn');
      renderViewers();
      break;
    }
    case 'kicked':
      leavePage(m.msg || 'The host removed you from the room.');
      break;
    case 'room-closed':
      leavePage(m.msg || 'The room ended.');
      break;
    case 'gif-search-result':
      if (m.tag === (document.getElementById('gif-grid')?.dataset.tag || 'trending')) renderGifGrid(m.items);
      break;
    case 'info':
      toast(m.msg || '');
      break;
    case 'error':
      if (m.fatalJoin) leavePage(m.msg);
      else toast(m.msg || 'Something went sideways', 'warn');
      break;
    default:
      break;
  }
}

function applyPlaybackState(p: Playback) {
  if (!p || !p.videoId) {
    mountedVideoId = null;
    lastPlayback = null;
    updateIdleState();
    return;
  }
  lastPlayback = p;
  const newVideo = p.videoId !== mountedVideoId;
  if (!yt || newVideo) {
    mountPlayer(p);
    return;
  }
  syncYt();
  updateIdleState();
}

function mountPlayer(p: Playback) {
  mountedVideoId = p.videoId;
  updateIdleState();
  loadYT().then((YT) => {
    if (!roomCode || deadSoon) return;
    if (!yt) {
      yt = new YT.Player('player', {
        width: '100%',
        height: '100%',
        playerVars: {
          autoplay: 1,
          mute: 1,
          rel: 0,
          playsinline: 1,
          controls: role === 'host' ? 1 : 0,
          iv_load_policy: 3,
        },
        events: {
          onReady: () => { startVideo(p); },
          onStateChange: (e: any) => { onYtState(e.data); },
        },
      });
    } else {
      startVideo(p);
    }
  });
}

function startVideo(p: Playback) {
  if (!yt || !p.videoId) return;
  const wantAt = Math.max(0, Math.floor(expectedPosition(p)));
  try { yt.setVolume(95); } catch { /* not ready */ }
  if (p.state === 'playing') {
    try { yt.loadVideoById(p.videoId, wantAt); } catch { return; }
    showCueIfMuted(true);
  } else {
    try { yt.cueVideoById(p.videoId, wantAt); yt.pauseVideo(); } catch { return; }
    showCueIfMuted(false);
  }
  if (role === 'guest') byId('shield').classList.remove('hidden');
}

function syncYt() {
  const p = lastPlayback;
  if (!p) return;
  const cur = safeState();
  if (p.state === 'playing') {
    const want = expectedPosition(p);
    if (Math.abs(safeTime() - want) > 1.7) {
      try { yt.seekTo(want, true); } catch { /* mid-load */ }
    }
    if (cur !== 1 && cur !== 3) { try { yt.playVideo(); } catch { /* blocked */ } }
  } else {
    if (cur === 1 || cur === 3) { try { yt.pauseVideo(); } catch { /* ok */ } }
  }
  showCueIfMuted(p.state === 'playing');
}

let lastEmit = 0;
function onYtState(state: number) {
  updatePlayIcon();
  if (role !== 'host') return;
  if (state === 1 || state === 2) {
    const now = Date.now();
    if (now - lastEmit > 250) { lastEmit = now; emitPlayback(); }
  }
}

function emitPlayback() {
  if (role !== 'host' || !mountedVideoId || !conn) return;
  const st = safeState();
  if (st !== 1 && st !== 2) return;
  conn.send({
    t: 'playback',
    videoId: mountedVideoId,
    state: st === 1 ? 'playing' : 'paused',
    position: safeTime(),
  });
}

function heartbeatTick() {
  if (role !== 'host') return;
  if (safeState() === 1) emitPlayback();
}

function uiTick() {
  if (!yt) return;
  const cur = safeTime();
  const dur = (() => { try { return yt.getDuration?.() || 0; } catch { return 0; } })();
  byId('ctl-state').textContent = fmt(cur) + ' / ' + (dur ? fmt(dur) : '--:--');
  if (role === 'host') {
    if (safeState() === 1 && !byId('cue').classList.contains('hidden') && userUnmuted) showCueIfMuted(false);
  }
  if (role === 'guest' && lastPlayback && lastPlayback.state === 'playing') {
    const want = expectedPosition(lastPlayback);
    if (Math.abs(safeTime() - want) > 1.9) syncYt();
  }
}

function showCueIfMuted(playing: boolean) {
  const cue = byId('cue');
  userUnmuted = ((): boolean => { try { return !yt?.isMuted?.(); } catch { return userUnmuted; } })();
  cue.classList.toggle('hidden', !(playing && !userUnmuted));
}

export function wireControls() {
  byId('ctl-play').addEventListener('click', () => {
    if (role !== 'host') return;
    if (safeState() === 1) { try { yt.pauseVideo(); } catch {} } else { try { yt.playVideo(); } catch {} }
  });
  byId('ctl-back').addEventListener('click', () => seekRel(-10));
  byId('ctl-fwd').addEventListener('click', () => seekRel(10));
  byId('ctl-sync').addEventListener('click', () => {
    if (role === 'host') {
      emitPlayback();
      toast('You are the master clock', 'violet');
      return;
    }
    conn?.send({ t: 'sync' });
    const b = byId('ctl-sync');
    b.classList.add('synced');
    window.setTimeout(() => b.classList.remove('synced'), 1600);
  });
  byId('ctl-video').addEventListener('click', () => openModal('modal-video'));
  byId('ctl-share').addEventListener('click', () => openModal('modal-share'));
  byId('topbar-share').addEventListener('click', () => openModal('modal-share'));
  byId('ctl-fs').addEventListener('click', toggleFs);
  byId('code-chip').addEventListener('click', () => {
    copyText(roomCode + '  —  ' + window.location.origin + '/r/' + roomCode);
    toast('Room code + link copied', 'violet');
  });
  byId('cue').addEventListener('click', unmuteFromCue);
  byId('shield').addEventListener('click', () => {
    toast('Playback is on the host', 'warn');
  });
  byId('empty-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = (byId('empty-url') as HTMLInputElement).value;
    const id = parseYtId(raw);
    if (!id) { toast('That link does not parse as YouTube', 'warn'); return; }
    (byId('empty-url') as HTMLInputElement).value = '';
    conn?.send({ t: 'set-video', videoId: id });
  });
  byId('video-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = (byId('video-url') as HTMLInputElement).value;
    const id = parseYtId(raw);
    if (!id) { toast('That link does not parse as YouTube', 'warn'); return; }
    (byId('video-url') as HTMLInputElement).value = '';
    closeModal('modal-video');
    conn?.send({ t: 'set-video', videoId: id });
  });
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange as EventListener);
  byId('fs-fab').addEventListener('click', () => {
    const hud = byId('fs-hud');
    hud.classList.toggle('open');
  });
  for (const b of document.querySelectorAll('[data-close]')) {
    b.addEventListener('click', () => closeModal((b as HTMLElement).dataset.close!));
  }
  document.querySelectorAll('.modal-back').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target === el) el.classList.remove('open');
    });
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllModals();
  });
}

function seekRel(delta: number) {
  if (role !== 'host') return;
  const t = Math.max(0, safeTime() + delta);
  try { yt.seekTo(t, true); } catch { /* not ready */ }
  emitPlayback();
}

function unmuteFromCue() {
  userUnmuted = true;
  try { yt.unMute(); yt.setVolume(95); if (safeState() !== 1) yt.playVideo(); } catch { /* ok */ }
  byId('cue').classList.add('hidden');
}

function updatePlayIcon() {
  const b = byId('ctl-play');
  b.textContent = safeState() === 1 ? '⏸' : '▶';
}

function updateIdleState() {
  const hasVideo = !!lastPlayback?.videoId && mountedVideoId !== null;
  byId('stage-idle').classList.toggle('hidden', hasVideo);
  if (!hasVideo) {
    byId('empty-form').classList.toggle('hidden', role !== 'host');
    byId('idle-title').textContent = role === 'host' ? 'The screen is off' : 'Waiting on the host';
    byId('idle-copy').textContent = role === 'host'
      ? 'Paste a YouTube link and press play — it starts for everyone at the same moment.'
      : 'The host has not started the show yet. Chat is open while you wait.';
  }
}

function toggleFs() {
  const shell = byId('player-shell');
  const anyShell = shell as any;
  if (!document.fullscreenElement && !(document as any).webkitFullscreenElement) {
    if (shell.requestFullscreen) shell.requestFullscreen().catch(() => {});
    else if (anyShell.webkitRequestFullscreen) anyShell.webkitRequestFullscreen();
  } else {
    if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    else if ((document as any).webkitExitFullscreen) (document as any).webkitExitFullscreen();
  }
}

function onFsChange() {
  const active = !!(document.fullscreenElement || (document as any).webkitFullscreenElement);
  document.body.classList.toggle('fs-mode', active);
  const sidebar = byId('sidebar');
  const hud = byId('fs-hud');
  const grid = document.querySelector('.room-grid')!;
  if (active) {
    hud.appendChild(sidebar);
    hud.classList.remove('open');
  } else {
    hud.classList.remove('open');
    grid.appendChild(sidebar);
  }
}

let ytReady: Promise<any> | null = null;
function loadYT(): Promise<any> {
  ytReady ||= new Promise((res) => {
    (window as any).onYouTubeIframeAPIReady = () => res((window as any).YT);
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(s);
  });
  return ytReady;
}

function feedEl(): HTMLElement { return byId('chat-feed'); }
function addNode(node: HTMLElement, isHistory: boolean) {
  if (isHistory) node.classList.add('history');
  const feed = feedEl();
  feed.appendChild(node);
  while (feed.children.length > 120) feed.firstElementChild?.remove();
  feed.scrollTop = feed.scrollHeight;
}
function avatarOf(name: string, color: string): HTMLElement {
  const av = document.createElement('span');
  av.className = 'av';
  av.textContent = (name[0] || '·').toUpperCase();
  av.style.background = color;
  return av;
}
function hhmm(at: number): string {
  const d = new Date(at || Date.now());
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function baseLine(name: string, color: string, isHistory: boolean, isSelf: boolean): { row: HTMLElement; body: HTMLElement } {
  const row = document.createElement('div');
  row.className = 'msg' + (isSelf ? ' self' : '');
  row.appendChild(avatarOf(name, color));
  const body = document.createElement('div');
  body.className = 'body';
  const head = document.createElement('div');
  head.className = 'head';
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = name;
  head.appendChild(who);
  if (isSelf) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = 'YOU';
    head.appendChild(tag);
  }
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = hhmm(Date.now());
  head.appendChild(time);
  body.appendChild(head);
  row.appendChild(body);
  if (isHistory) row.classList.add('history');
  return { row, body };
}

function addChatLine(name: string, text: string, fromId: string, isHistory: boolean) {
  const nameStr = String(name || '·');
  const self = fromId === me.id;
  const { row, body } = baseLine(nameStr, O.colorFor(nameStr), isHistory, self);
  const txt = document.createElement('div');
  txt.className = 'txt';
  txt.textContent = String(text).slice(0, 500);
  body.appendChild(txt);
  addNode(row, isHistory);
  if (!isHistory && fromId !== me.id) O.spawnMessage(nameStr, String(text));
}
function addGifLine(name: string, url: string, fromId: string, isHistory: boolean) {
  const nameStr = String(name || '·');
  const self = fromId === me.id;
  const { row, body } = baseLine(nameStr, O.colorFor(nameStr), isHistory, self);
  const gifByte = document.createElement('span');
  gifByte.className = 'gif-byte';
  gifByte.textContent = 'GIF';
  (body.firstElementChild as HTMLElement).appendChild(gifByte);
  const img = document.createElement('img');
  img.src = String(url).slice(0, 400);
  img.alt = 'GIF';
  body.appendChild(img);
  addNode(row, isHistory);
  if (!isHistory && fromId !== me.id) O.spawnGif(String(url));
}
function addReactLine(name: string, emoji: string, isHistory: boolean) {
  const row = document.createElement('div');
  row.className = 'msg reactmsg' + (isHistory ? ' history' : '');
  const whoEl = document.createElement('span');
  whoEl.className = 'who';
  whoEl.textContent = String(name || '·');
  whoEl.style.color = O.colorFor(String(name || '·'));
  const txt = document.createElement('span');
  txt.className = 'txt';
  txt.textContent = ' ' + emoji;
  row.append(whoEl, txt);
  addNode(row, isHistory);
}
function addSys(text: string) {
  const row = document.createElement('div');
  row.className = 'msg sys';
  row.textContent = text;
  addNode(row, false);
}
function renderHistory(list: any[]) {
  for (const ev of list) {
    const age = Date.now() - (ev.at || 0);
    if (age > 30 * 60 * 1000) continue;
    if (ev.k === 'chat') addChatLine(ev.name ?? ev.fromName, ev.text, ev.fromId, true);
    else if (ev.k === 'gif') addGifLine(ev.name ?? ev.fromName, ev.url, ev.fromId, true);
    else if (ev.k === 'sys') addSys(ev.text || '');
  }
}

function renderViewers() {
  const list = document.getElementById('viewers-list') || byId('viewers-list');
  list.textContent = '';
  let ghosts = 0;
  const ordered = [...viewers].sort((a, b) => (a.ghost ? 1 : 0) - (b.ghost ? 1 : 0));
  for (const v of ordered) {
    if (v.ghost) ghosts++;
    const row = document.createElement('div');
    row.className = 'vrow' + (v.ghost ? ' ghosted' : '');
    row.dataset.id = v.id;
    const dot = document.createElement('span');
    dot.className = 'dot';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = v.name + (v.id === me.id ? ' (you)' : '');
    name.style.color = v.role === 'host' ? O.colorFor(v.name) : '';
    row.append(dot, name);
    if (v.role === 'host') {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'HOST';
      row.appendChild(tag);
    }
    if (v.muted) {
      const mt = document.createElement('span');
      mt.className = 'mutetag';
      mt.textContent = '· MUTED';
      row.appendChild(mt);
    }
    if (role === 'host' && v.id !== me.id) {
      const btn = document.createElement('button');
      btn.className = 'menu-btn';
      btn.type = 'button';
      btn.textContent = '•••';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = row.querySelector('.mod-pop');
        list.querySelectorAll('.mod-pop').forEach((p) => p.remove());
        if (open) return;
        const pop = document.createElement('div');
        pop.className = 'mod-pop';
        const muteBtn = document.createElement('button');
        muteBtn.type = 'button';
        muteBtn.textContent = v.muted ? 'UNMUTE' : 'MUTE';
        muteBtn.addEventListener('click', () => {
          conn?.send({ t: 'moderate', target: v.id, action: 'mute' });
          pop.remove();
        });
        const kickBtn = document.createElement('button');
        kickBtn.type = 'button';
        kickBtn.className = 'kick';
        kickBtn.textContent = 'REMOVE';
        kickBtn.addEventListener('click', () => {
          conn?.send({ t: 'moderate', target: v.id, action: 'kick' });
          pop.remove();
        });
        pop.append(muteBtn, kickBtn);
        row.appendChild(pop);
      });
      row.appendChild(btn);
    }
    list.appendChild(row);
  }
  const watching = viewers.length;
  byId('watch-n').textContent = String(Math.max(1, watching));
  byId('side-count').textContent = String(watching);
  document.title = 'WATCH// · #' + roomCode + ' · ' + watching + ' watching';
}

function tickerAdd(emoji: string) {
  const box = byId('react-ticker');
  const hint = box.querySelector('.hint');
  if (hint) hint.remove();
  let last = box.lastElementChild as (HTMLElement & { count: number }) | null;
  if (last && last.dataset.emoji === emoji && Date.now() - (+(last.dataset.at || 0)) < 2500) {
    last.count = (+(last.dataset.n ?? '1') || 1) + 1;
    last.dataset.n = String(last.count);
    (last.querySelector('i') as HTMLElement).textContent = '×' + last.count;
    last.style.animation = 'none';
    void last.offsetWidth;
    last.style.animation = '';
  } else {
    const tk = document.createElement('span') as HTMLElement & { count: number };
    tk.className = 'tk';
    tk.dataset.emoji = emoji;
    tk.dataset.at = String(Date.now());
    tk.dataset.n = '1';
    tk.textContent = emoji;
    const n = document.createElement('i');
    n.textContent = '×1';
    tk.appendChild(n);
    box.appendChild(tk);
    while (box.children.length > 14) box.firstElementChild?.remove();
  }
}

function buildComposer() {
  byId('send-btn').addEventListener('click', sendChat);
  byId('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
  });
  byId('btn-gif').addEventListener('click', () => {
    byId('emoji-panel').classList.remove('open');
    byId('btn-emoji').classList.toggle('on', false);
    const panel = byId('gif-panel');
    panel.classList.toggle('hidden');
    byId('btn-gif').classList.toggle('on', !panel.classList.contains('hidden'));
    if (!panel.classList.contains('hidden')) sendGifSearch(currentTag);
  });
  window.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest('#gif-panel') && !t.closest('#btn-gif')) {
      if (!byId('gif-panel').classList.contains('hidden')) {
        byId('gif-panel').classList.add('hidden');
        byId('btn-gif').classList.remove('on');
      }
    }
  });
}
function sendChat() {
  const input = byId('chat-input') as HTMLInputElement;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  conn?.send({ t: 'chat', text });
}

let currentTag = 'trending';
function buildGifTags(active: string) {
  if (currentTag) active = currentTag;
  const tags = byId('gif-tags');
  tags.textContent = '';
  for (const tg of GIF_TAGS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = tg;
    b.classList.toggle('on', tg === active);
    b.addEventListener('click', () => {
      buildGifTags(tg);
      sendGifSearch(tg);
    });
    tags.appendChild(b);
  }
}
function sendGifSearch(tag: string) {
  currentTag = tag;
  byId('gif-grid').dataset.tag = tag;
  byId('gif-grid').innerHTML = '<div class="loading">LOADING GIFS…</div>';
  conn?.send({ t: 'gif-search', tag });
}
function renderGifGrid(items: any[]) {
  const grid = byId('gif-grid');
  grid.textContent = '';
  if (!items?.length) {    grid.innerHTML = '<div class="empty">NO GIFS FOR THIS MOOD<br/><br/>SET GIPHY_API_KEY FOR MORE</div>';
    return;
  }
  for (const g of items.slice(0, 12)) {
    const img = document.createElement('img');
    img.src = g.preview || g.url;
    img.alt = 'gif';
    img.loading = 'lazy';
    img.addEventListener('click', () => {
      conn?.send({ t: 'gif', id: g.id, url: g.url, w: g.w, h: g.h });
      byId('gif-panel').classList.add('hidden');
      byId('btn-gif').classList.remove('on');
    });
    grid.appendChild(img);
  }
}

function buildEmojiPanel() {
  const panel = byId('emoji-panel');
  panel.textContent = '';
  for (const e of EMOJIS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = e;
    b.addEventListener('click', () => {
      conn?.send({ t: 'reaction', emoji: e });
      panel.classList.remove('open');
      byId('btn-emoji').classList.remove('on');
    });
    panel.appendChild(b);
  }
  byId('btn-emoji').addEventListener('click', (e) => {
    e.stopPropagation();
    byId('gif-panel').classList.add('hidden');
    byId('btn-gif').classList.remove('on');
    panel.classList.toggle('open');
    byId('btn-emoji').classList.toggle('on');
  });
}

function openModal(id: string) { byId(id).classList.add('open'); }
function closeModal(id: string) { byId(id).classList.remove('open'); }
function closeAllModals() { document.querySelectorAll('.modal-back.open').forEach((m) => m.classList.remove('open')); }

export function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    return;
  }
  fallbackCopy(text);
}
function fallbackCopy(text: string) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch { /* best effort */ }
  ta.remove();
}
