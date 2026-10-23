import { initRoom, wireControls } from './room';

const byId = (id: string) => document.getElementById(id) as HTMLElement;

function flip(name: 'home' | 'gate' | 'room') {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  byId('view-' + name).classList.add('active');
}

function savedName(): string {
  return localStorage.getItem('watch.name') || '';
}
function rememberName(n: string) {
  localStorage.setItem('watch.name', n);
}

export function boot() {
  const path = window.location.pathname;
  const joinMatch = /^\/r\/([A-Za-z0-9]{3,12})\/?$/i.exec(path);
  const createMatch = /^\/new\/?$/i.test(path);

  flip('home');
  wireControls();

  const pending = sessionStorage.getItem('watch.pending-name') || '';
  sessionStorage.removeItem('watch.pending-name');

  if (joinMatch || createMatch) {
    const code = joinMatch ? joinMatch[1].toUpperCase() : '';
    const gate = byId('gate-name') as HTMLInputElement;
    gate.value = pending || savedName();
    flip('gate');
    if (createMatch) {
      byId('gate-stamp').textContent = 'NEW ROOM · YOU WILL BE THE HOST';
      byId('gate-sub').textContent = 'Six-character code + invite link lands right after this.';
      byId('gate-go').textContent = 'Create the room';
    } else {
      byId('gate-stamp').textContent = 'JOINING ROOM #' + code;
      byId('gate-go').textContent = 'Enter room';
    }
    (byId('gate-form') as HTMLFormElement).addEventListener('submit', (e) => {
      e.preventDefault();
      const name = gate.value.trim();
      if (!name) { gate.focus(); return; }
      rememberName(name);
      flip('room');
      initRoom(createMatch ? 'create' : 'join', name, code);
    });
    gate.focus();
    return;
  }

  const nameInput = byId('home-name') as HTMLInputElement;
  nameInput.value = savedName();
  (byId('create-form') as HTMLFormElement).addEventListener('submit', (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    rememberName(name);
    sessionStorage.setItem('watch.pending-name', name);
    window.location.href = '/new';
  });
  (byId('join-form') as HTMLFormElement).addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = (byId('home-code') as HTMLInputElement).value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (raw.length !== 6) { (byId('home-code') as HTMLInputElement).focus(); return; }
    window.location.href = '/r/' + raw;
  });
  nameInput.focus();
}
