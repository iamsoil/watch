const overlayBox = () => document.getElementById('overlays') as HTMLDivElement;

function rand(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function makeOv(cls: string, life: number): HTMLDivElement {
  const box = overlayBox();
  const ov = document.createElement('div');
  ov.className = 'ov ' + cls;
  ov.style.setProperty('--x', rand(6, 62) + '%');
  ov.style.setProperty('--vhpx', String(Math.max(6, Math.min(14, window.innerHeight / 90))));
  box.appendChild(ov);
  window.setTimeout(() => ov.remove(), life);
  if (box.children.length > 9) box.firstElementChild?.remove();
  return ov;
}

const AV_COLORS = ['#8f45ff', '#ff4d6d', '#2ee6a8', '#ffb703', '#4cc9f0', '#f77f6a', '#c77dff'];
export function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AV_COLORS[h % AV_COLORS.length];
}

export function spawnMessage(name: string, text: string) {
  const ov = makeOv('ov-msg', 6200);
  const av = document.createElement('span');
  av.className = 'av';
  av.textContent = (name[0] || '·').toUpperCase();
  av.style.background = colorFor(name);
  const body = document.createElement('span');
  body.className = 'body';
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = name;
  const txt = document.createElement('div');
  txt.className = 'txt';
  txt.textContent = text;
  body.append(who, txt);
  ov.append(av, body);
}

export function spawnGif(url: string) {
  const ov = makeOv('ov-gif', 7200);
  const img = document.createElement('img');
  img.src = url;
  img.alt = 'GIF';
  ov.appendChild(img);
}

export function spawnReaction(emoji: string) {
  const ov = makeOv('ov-react', 2900);
  ov.style.setProperty('--rz', String(Math.round(rand(34, 58))));
  ov.textContent = emoji;
}

let slugTimer: number | null = null;

export function setSlug(who: string | null, txt: string) {
  const slug = document.getElementById('slug')!;
  if (slugTimer !== null) {
    window.clearTimeout(slugTimer);
    slugTimer = null;
  }
  if (!who) {
    slug.classList.add('hidden');
    return;
  }
  document.getElementById('slug-who')!.textContent = who + ':';
  document.getElementById('slug-txt')!.textContent = txt;
  slug.classList.remove('hidden');
  slugTimer = window.setTimeout(() => {
    slug.classList.add('hidden');
    slugTimer = null;
  }, 7200);
}
