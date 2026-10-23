const GIPHY_KEY = process.env.GIPHY_API_KEY || process.env.GIPHY_KEY || '';
const CACHE_TTL = 600000;

const VERIFIED = [
  { id: 'gh-hype', url: 'https://media.giphy.com/media/DYH297XiCS2Ck/giphy.gif', w: 240, h: 180, tag: 'hype' },
  { id: 'gh-popcorn', url: 'https://media.giphy.com/media/XJtM2nNFCzT3etvzOB/giphy.gif', w: 240, h: 150, tag: 'popcorn' },
  { id: 'gh-yes', url: 'https://media.giphy.com/media/cPUMQkF2A19vy/giphy.gif', w: 240, h: 160, tag: 'yes' },
];

const LOCAL_TAGS = ['clap', 'lol', 'wow', 'yes', 'nope', 'love', 'facepalm', 'shock', 'applause'];
const LOCALS = LOCAL_TAGS.map(tag => ({
  id: 'wtn-' + tag,
  url: '/fallback/' + tag + '.gif',
  w: 120,
  h: 75,
  tag,
  local: true,
}));

const TRENDING_ORDER = ['wtn-clap', 'gh-hype', 'wtn-lol', 'gh-yes', 'wtn-shock', 'gh-popcorn', 'wtn-love', 'wtn-wow'];
const ALL_TAGS = ['trending', 'hype', 'lol', 'wow', 'clap', 'popcorn', 'love', 'nope', 'shock', 'facepalm', 'applause', 'yes'];
const GIPHY_QUERY = new Map(ALL_TAGS.map(t => [t, t]));
GIPHY_QUERY.set('clap', 'applause clapping');
GIPHY_QUERY.set('nope', 'no way nope');
GIPHY_QUERY.set('shock', 'shocked omg');
GIPHY_QUERY.set('hype', 'hypnotized excited');

const cache = new Map();
const itemsById = new Map([...LOCALS.map(l => [l.id, l]), ...VERIFIED.map(v => [v.id, v])]);

function localsFor(tag) {
  if (tag === 'trending') return TRENDING_ORDER.map(id => itemsById.get(id)).filter(Boolean);
  return LOCALS.filter(l => l.tag === tag);
}

async function giphySearch(tag) {
  if (!GIPHY_KEY) return [];
  const url = 'https://api.giphy.com/v1/gifs/search?api_key=' + encodeURIComponent(GIPHY_KEY)
    + '&q=' + encodeURIComponent(GIPHY_QUERY.get(tag) || tag || 'reaction')
    + '&limit=8&rating=pg';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.data || []).map(g => {
      const im = g.images || {};
      const main = im.fixed_width?.url || im.downsized_medium?.url || im.downsized?.url || null;
      if (!main) return null;
      return {
        id: g.id,
        url: main,
        w: Number(im.fixed_width?.width) || 200,
        h: Number(im.fixed_width?.height) || 150,
        preview: im.preview_gif?.url || im.fixed_width_small?.url || main,
      };
    }).filter(Boolean);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function searchGifs(tagRaw) {
  const tag = String(tagRaw || 'trending').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'trending';
  const cached = cache.get(tag);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.items;
  const giphy = await giphySearch(tag);
  const baked = localsFor(tag);
  const verified = tag === 'trending'
    ? VERIFIED.filter(v => v.tag !== 'popcorn' && v.tag !== 'yes')
    : VERIFIED.filter(v => v.tag === tag);
  const seen = new Set();
  const items = [...giphy, ...baked, ...verified].filter(x => {
    if (!x || seen.has(x.url)) return false;
    seen.add(x.url);
    return true;
  });
  cache.set(tag, { ts: Date.now(), items });
  return items;
}
