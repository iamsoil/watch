import { searchGifs } from './gifs.js';

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const EMOJIS = ['😂', '🔥', '💖', '😱', '👏', '😲', '🤯', '😢', '🎬', '🍿', '👀', '💀', '😍', '🥳', '🫡', '🤔'];
const NAME_MAX = 24;
const CHAT_MAX = 500;
const VIEWER_CAP = 8;
const HIST_MAX = 80;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const GIF_URL_RE = /^https:\/\/[\w.-]+\/\S+$/;
const GHOST_NAMES = ['Nova', 'Rex', 'Juno', 'Pixel', 'Moss', 'Echo', 'Byte', 'Sable', 'Kite', 'Vera'];
const GHOST_LINES = [
  'this exact scene is why we came',
  'ok the sync never gets old',
  'shhh the good part',
  'popcorn break',
  'the chat silence is suspicious',
  'saving this one to rewatch later',
  'vibe check passed',
  'rewind it back ten seconds',
  'host we trust',
  'the autoplay of legend',
];

function now() { return Date.now(); }
function uid() { return 'v' + Math.random().toString(36).slice(2, 10); }
function cleanName(raw) {
  const n = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
  return n || 'Viewer';
}
function clampPos(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(60000, Math.round(x * 10) / 10));
}

class Room {
  constructor(code, hub) {
    this.code = code;
    this.hub = hub;
    this.viewers = new Map();
    this.hostId = null;
    this.hostless = true;
    this.hostlessAt = 0;
    this.playback = { videoId: null, state: 'empty', position: 0, at: now() };
    this.history = [];
    this.lastRealLeave = now();
    this.lastGhostChat = 0;
    this.ghostTimer = setInterval(() => this.tickGhosts(), 3600);
  }

  destroyed(goodbyeMsg) {
    clearInterval(this.ghostTimer);
    this.hub.rooms.delete(this.code);
    for (const v of this.viewers.values()) {
      if (v.ws && v.ws.readyState === 1) {
        try {
          this.hub.send(v.ws, 'room-closed', { msg: goodbyeMsg || 'This room ended.' });
          v.ws.close(4004, 'room closed');
        } catch {}
      }
      if (v.ws) this.hub.byWs.delete(v.ws);
      v.ws = null;
    }
    this.viewers.clear();
  }

  realCount() {
    let n = 0;
    for (const v of this.viewers.values()) if (!v.ghost) n++;
    return n;
  }
  ghostCount() {
    let n = 0;
    for (const v of this.viewers.values()) if (v.ghost) n++;
    return n;
  }
  viewer(id) { return this.viewers.get(id); }

  snap() {
    return [...this.viewers.values()].map(v => ({
      id: v.id, name: v.name, role: v.role, muted: v.muted, ghost: v.ghost,
    }));
  }

  broadcastViewers() {
    this.hub.broadcast(this, 'viewers', { viewers: this.snap(), hostless: this.hostless });
  }
  sys(text) {
    this.history.push({ k: 'sys', text, ts: now() });
    if (this.history.length > HIST_MAX) this.history.splice(0, this.history.length - HIST_MAX);
  }

  tickGhosts() {
    if (process.env.WATCH_GHOSTS === 'off') return;
    if (this.hostless || this.destroyed) return;
    const real = this.realCount();
    if (real === 0) {
      if (this.viewers.size < 3 && Math.random() < 0.5) this.addGhost();
      if (this.viewers.size > 0 && Math.random() < 0.12) this.dropGhost();
    } else if (real === 1) {
      if (this.ghostCount() < 2 && Math.random() < 0.4) this.addGhost();
      if (this.ghostCount() > 0 && Math.random() < 0.25) this.dropGhost();
    } else {
      if (this.ghostCount() > 0 && Math.random() < 0.7) this.dropGhost();
    }
    const ghosts = [...this.viewers.values()].filter(v => v.ghost);
    if (!ghosts.length || Math.random() < 0.25) return;
    const agent = ghosts[Math.random() * ghosts.length | 0];
    if (Math.random() < 0.55) {
      this.hub.broadcast(this, 'reaction', { from: agent.name, emoji: EMOJIS[Math.random() * EMOJIS.length | 0], at: now() });
      return;
    }
    if (now() - this.lastGhostChat > 18000 && Math.random() < 0.8) {
      this.lastGhostChat = now();
      const line = GHOST_LINES[Math.random() * GHOST_LINES.length | 0];
      this.hub.broadcast(this, 'chat', { fromId: agent.id, fromName: agent.name, text: line, at: now() });
    }
  }

  addGhost() {
    const used = new Set([...this.viewers.values()].map(v => v.name));
    const pool = GHOST_NAMES.filter(n => !used.has(n));
    const name = pool.length ? pool[Math.random() * pool.length | 0] : 'Watcher' + (this.ghostCount() + 1);
    const g = { id: uid(), ws: null, name, role: 'guest', muted: false, ghost: true };
    this.viewers.set(g.id, g);
    this.sys(name + ' slipped in.');
    this.hub.broadcast(this, 'presence', { kind: 'joined', name });
    this.broadcastViewers();
  }

  dropGhost() {
    const ghosts = [...this.viewers.values()].filter(v => v.ghost);
    if (!ghosts.length) return;
    const g = ghosts[ghosts.length - 1];
    this.viewers.delete(g.id);
    this.broadcastViewers();
  }
}

export class Hub {
  constructor() {
    this.rooms = new Map();
    this.byWs = new Map();
    this.sweep = setInterval(() => this.sweepIdle(), 20000);
    this.sweep.unref?.();
  }

  client(ws) { return this.byWs.get(ws); }

  connect(ws) {
    ws.isAlive = true;
    this.byWs.set(ws, { ws, id: uid(), name: 'Viewer', role: 'guest', room: null, muted: false, last: {} });
  }

  disconnect(ws) {
    const c = this.byWs.get(ws);
    if (!c) return;
    this.byWs.delete(ws);
    this.leave(c, 'left');
  }

  sweepIdle() {
    const nowT = now();
    for (const room of [...this.rooms.values()]) {
      if (room.realCount() > 0) room.lastRealLeave = nowT;
      else if (nowT - room.lastRealLeave > 60000) {
        room.sys('Room closed: everyone drifted away.');
        room.destroyed('Room closed — everyone left.');
      }
    }
  }

  leave(c, verb) {
    const room = c.room;
    if (!room) return;
    c.room = null;
    room.viewers.delete(c.id);
    this.byWs.delete(c.ws);
    if (c.id === room.hostId) {
      room.hostless = true;
      room.hostlessAt = now();
      if (room.playback.state === 'playing') {
        room.playback = { ...room.playback, state: 'paused', at: now() };
      }
      room.sys('The host stepped away. Next person to join can take over.');
      this.broadcast(room, 'presence', { kind: 'host-gone' });
      this.broadcast(room, 'playback', room.playback);
    } else {
      room.sys(c.name + ' ' + verb + '.');
      this.broadcast(room, 'presence', { kind: verb, name: c.name });
    }
    if (!c.ghost) room.lastRealLeave = now();
    this.broadcast(room, 'viewers', { viewers: room.snap(), hostless: room.hostless });
  }
  create(c, name) {
    if (c.room) this.leave(c, 'left');
    let code;
    for (let i = 0; i < 64; i++) {
      let s = '';
      for (let j = 0; j < 6; j++) s += CODE_CHARS[Math.random() * CODE_CHARS.length | 0];
      if (!this.rooms.has(s)) { code = s; break; }
    }
    if (!code) { c.ws.send(JSON.stringify({ t: 'error', msg: 'Could not allocate a room code, try again.' })); return; }
    c.name = cleanName(name);
    c.role = 'host';
    const room = new Room(code, this);
    this.rooms.set(code, room);
    c.room = room;
    room.hostless = false;
    room.hostId = c.id;
    room.viewers.set(c.id, { id: c.id, ws: c.ws, name: c.name, role: 'host', muted: false, ghost: false });
    this.send(c.ws, 'created', {
      code, you: { id: c.id, name: c.name, role: 'host' },
      playback: room.playback, viewers: room.snap(), hostless: false,
    });
    this.broadcast(room, 'viewers', { viewers: room.snap(), hostless: false });
  }

  join(c, code, name, asHost) {
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const room = this.rooms.get(code);
    if (!room) { this.send(c.ws, 'error', { msg: 'Room not found. Double-check the code.', fatalJoin: true }); return; }
    if (c.room === room) { this.send(c.ws, 'joined', this.joinPayload(c, room)); return; }
    if (c.room) this.leave(c, 'left');
    const real = room.realCount() + 1;
    if (real > VIEWER_CAP && room.ghostCount() > 0) room.dropGhost();
    if (real > VIEWER_CAP) { this.send(c.ws, 'error', { msg: 'Room is full (8 viewers max).', fatalJoin: true }); return; }
    let n = cleanName(name);
    const used = new Set([...room.viewers.values()].map(v => v.name));
    while (used.has(n)) n = n.slice(0, NAME_MAX - 2).trim() + ' ·' + (Math.random() * 9 + 1).toFixed().slice(0, 1);
    c.name = n;
    c.role = 'guest';
    c.room = room;
    c.muted = false;
    if (room.hostless) {
      c.role = 'host';
      room.hostless = false;
      room.hostId = c.id;
      room.sys(n + ' took over the room as host.');
      this.broadcast(room, 'presence', { kind: 'host-back', name: n });
    } else {
      room.sys(n + ' joined. Say hi!');
      this.broadcast(room, 'presence', { kind: 'joined', name: n });
    }
    room.viewers.set(c.id, { id: c.id, ws: c.ws, name: c.name, role: c.role, muted: false, ghost: false });
    this.send(c.ws, 'joined', this.joinPayload(c, room));
    this.broadcast(room, 'viewers', { viewers: room.snap(), hostless: room.hostless });
  }

  joinPayload(c, room) {
    return {
      code: room.code,
      you: { id: c.id, name: c.name, role: c.role },
      viewers: room.snap(),
      playback: room.playback,
      history: room.history,
      hostless: room.hostless,
      watching: room.viewers.size,
    };
  }

  async handleMessage(ws, raw) {
    const c = this.byWs.get(ws);
    if (!c) return;
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { this.send(ws, 'error', { msg: 'Unreadable message.' }); return; }
    if (!msg || typeof msg !== 'object') return;
    const room = c.room;
    try {
      switch (msg.t) {
        case 'create': this.create(c, msg.name); break;
        case 'join': this.join(c, msg.code, msg.name, !!msg.asHost); break;
        case 'rename': {
          if (!room) return;
          c.name = cleanName(msg.name);
          this.broadcast(room, 'viewers', { viewers: room.snap(), hostless: room.hostless });
          break;
        }
        case 'chat': {
          if (!room) return;
          if (c.muted) { this.send(ws, 'muted-you', { muted: true }); return; }
          if (!this.bumpLast(c, 'chat', 350)) return;
          const text = String(msg.text ?? '').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX);
          if (!text || c.lastChatText === text) return;
          c.lastChatText = text;
          room.history.push({ k: 'chat', name: c.name, text, fromId: c.id, at: now() });
          if (room.history.length > HIST_MAX) room.history.splice(0, room.history.length - HIST_MAX);
          this.broadcast(room, 'chat', { fromId: c.id, fromName: c.name, text, at: now() });
          break;
        }
        case 'reaction': {
          if (!room) return;
          if (c.muted) { this.send(ws, 'muted-you', { muted: true }); return; }
          if (!this.bumpLast(c, 'reaction', 300)) return;
          const emoji = String(msg.emoji ?? '');
          if (!EMOJIS.includes(emoji)) return;
          this.broadcast(room, 'reaction', { fromId: c.id, fromName: c.name, emoji, at: now() });
          break;
        }
        case 'gif': {
          if (!room) return;
          if (c.muted) { this.send(ws, 'muted-you', { muted: true }); return; }
          if (!this.bumpLast(c, 'gif', 2200)) return;
          const url = String(msg.url ?? '');
          if (!GIF_URL_RE.test(url)) return;
          const entry = {
            id: String(msg.id ?? '').slice(0, 40) || uid(),
            url: url.slice(0, 400),
            fromId: c.id,
            fromName: c.name,
            at: now(),
          };
          room.history.push({ k: 'gif', name: c.name, url: entry.url, fromId: c.id, at: entry.at });
          if (room.history.length > HIST_MAX) room.history.splice(0, room.history.length - HIST_MAX);
          this.broadcast(room, 'gif', entry);
          break;
        }
        case 'playback': {
          if (!room || c.id !== room.hostId) return;
          if (!this.bumpLast(c, 'playback', 250)) return;
          const state = msg.state === 'paused' ? 'paused' : 'playing';
          if (msg.videoId !== undefined) {
            const vid = String(msg.videoId ?? '');
            if (VIDEO_ID_RE.test(vid)) room.playback.videoId = vid;
          }
          room.playback = { videoId: room.playback.videoId, state, position: clampPos(msg.position), at: now() };
          this.broadcast(room, 'playback', room.playback);
          break;
        }
        case 'set-video': {
          if (!room || c.id !== room.hostId) return;
          const vid = String(msg.videoId ?? '');
          if (!VIDEO_ID_RE.test(vid)) { this.send(ws, 'error', { msg: 'That link/ID does not look like YouTube.' }); return; }
          room.playback = { videoId: vid, state: 'playing', position: 0, at: now() };
          room.sys(c.name + ' set the reel.');
          this.broadcast(room, 'playback', { ...room.playback, changed: true });
          this.broadcast(room, 'viewers', { viewers: room.snap(), hostless: room.hostless });
          break;
        }
        case 'sync': {
          if (!room) return;
          if (!this.bumpLast(c, 'sync', 1200)) return;
          if (room.hostless) { this.send(ws, 'info', { msg: 'No host online — showing last known state.' }); return; }
          const host = room.viewers.get(room.hostId);
          if (host?.ws?.readyState === 1) this.send(host.ws, 'sync-request', { fromName: c.name });
          break;
        }
        case 'moderate': {
          if (!room || c.id !== room.hostId) return;
          const target = room.viewers.get(String(msg.target ?? ''));
          if (!target || target.id === room.hostId) return;
          if (msg.action === 'kick') {
            if (target.ghost) {
              room.viewers.delete(target.id);
              room.sys(target.name + ' was removed by the host.');
              this.broadcast(room, 'presence', { kind: 'kicked', name: target.name });
              this.broadcast(room, 'viewers', { viewers: room.snap(), hostless: room.hostless });
            } else if (target.ws) {
              room.sys(target.name + ' was removed by the host.');
              this.broadcast(room, 'presence', { kind: 'kicked', name: target.name });
              try { this.send(target.ws, 'kicked', { msg: 'The host removed you from the room.' }); } catch {}
              setTimeout(() => { try { target.ws.close(4003, 'kicked'); } catch {} }, 60);
              room.viewers.delete(target.id);
              this.broadcast(room, 'viewers', { viewers: room.snap(), hostless: room.hostless });
            }
          } else if (msg.action === 'mute') {
            target.muted = !target.muted;
            if (!target.ghost) {
              const conn2 = [...this.byWs.values()].find(x => x.id === target.id);
              if (conn2) conn2.muted = target.muted;
            }
            if (!target.ghost && target.ws) this.send(target.ws, 'muted-you', { muted: target.muted });
            room.sys(target.name + (target.muted ? ' was muted.' : ' can speak again.'));
            this.broadcast(room, 'presence', { kind: target.muted ? 'muted' : 'unmuted', name: target.name });
            this.broadcast(room, 'viewers', { viewers: room.snap(), hostless: room.hostless });
          }
          break;
        }
        case 'gif-search': {
          if (!room) return;
          if (!this.bumpLast(c, 'gifSearch', 1500)) return;
          const tag = String(msg.tag ?? 'trending');
          const items = await searchGifs(tag);
          this.send(ws, 'gif-search-result', { tag, items });
          break;
        }
        default: return;
      }
    } catch (e) {
      this.send(ws, 'error', { msg: 'Server hiccup: ' + (e && e.message || 'unknown') });
    }
  }

  bumpLast(c, key, windowMs) {
    const t = now();
    if (t - (c.last[key] || 0) < windowMs) return false;
    c.last[key] = t;
    return true;
  }

  broadcast(room, t, data) {
    const payload = JSON.stringify({ t, ...data });
    for (const v of room.viewers.values()) {
      if (v.ws && v.ws.readyState === 1) {
        try { v.ws.send(payload); } catch {}
      }
    }
  }

  send(ws, t, data = {}) {
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify({ t, ...data })); } catch {}
    }
  }
}
