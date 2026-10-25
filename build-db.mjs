// Builds the FUT SBC Solver database from FUT.GG and writes it to ./public:
//   public/db.json      players: rating, rarity, club, league, nation, positions, name
//   public/prices.json  every player's price (console + PC) and tradability
//   public/meta.json    build time + counts (small, polled by the extension)
// Runs hourly on GitHub Actions; merges with the previously published database so
// coverage only grows. Exits non-zero on failure so the last good version stays live.
import { mkdir, writeFile } from 'node:fs/promises';

const YEAR = Number(process.env.FUT_YEAR || 27);
const PREV_URL = (process.env.PREV_URL || '').replace(/\/+$/, '');
const CDN = `https://r2.fut.gg/${YEAR}`;
const PLAYERS_API = `https://www.fut.gg/api/fut/players/v2/${YEAR}/`;
const GAP_MS = 700;           // spacing between player-list requests
const MAX_FAILURES = 25;
const HEADERS = { accept: 'application/json', 'user-agent': 'fut-sbc-db (hourly cache; github actions)' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function getJson(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(String(url), { headers: HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(2000 * i);
    }
  }
}

// ───────── full price table (FUT.GG bulk files) ─────────
async function buildPrices() {
  const man = await getJson(`${CDN}/manifest.json`);
  const ver = man?._version;
  const blobUrl = (key) => {
    const hash = man?.[key];
    if (!Number.isInteger(ver) || !/^[A-Za-z0-9_-]+$/.test(hash || '')) throw new Error(`FUT.GG layout changed (missing ${key})`);
    return `${CDN}/${key}.v${ver}.${hash}.json`;
  };
  const [index, ps, pc] = await Promise.all([
    getJson(blobUrl('player-prices-index')),
    getJson(blobUrl('player-prices-ps5-dyn')),
    getJson(blobUrl('player-prices-pc-dyn')),
  ]);
  for (const [name, b] of [['console', ps], ['pc', pc]]) {
    if (index?.v !== 2 || b?.v !== 2) throw new Error(`FUT.GG price format changed (${name})`);
    if (!Array.isArray(b.p) || !Array.isArray(b.s) || b.p.length !== index.d.length + 1 || b.s.length !== b.p.length) {
      throw new Error(`FUT.GG price data inconsistent (${name})`);
    }
  }
  // Same delta-encoded ID list as FUT.GG; tradable: 0 for SBC / objective / untradeable.
  const n = ps.p.length;
  const t = new Array(n);
  for (let i = 0; i < n; i++) { const s = Number(ps.s[i]); t[i] = s === 1 || s === 2 || s === 4 ? 0 : 1; }
  const toPrice = (v) => (Number(v) > 0 ? Number(v) : 0);
  const table = { v: 1, year: YEAR, id0: Number(index.id0), d: index.d.map(Number), console: ps.p.map(toPrice), pc: pc.p.map(toPrice), t };
  const map = new Map();
  let id = table.id0;
  for (let i = 0; i < n; i++) { if (i) id += table.d[i - 1]; map.set(id, { c: table.console[i], p: table.pc[i], t: t[i] }); }
  log(`prices: ${n} players`);
  return { table, map };
}

// ───────── player details (FUT.GG player list, cheapest first) ─────────
function row(r) {
  if (String(r?.game) !== String(YEAR)) return null;
  const id = Number(r.eaId), rating = Number(r.overall);
  if (!Number.isFinite(id) || !Number.isFinite(rating)) return null;
  const pos = Number(r.positionId);
  return [
    id, rating, Number(r.rarityEaId ?? r.rarityId ?? 0),
    Number(r.uniqueClubEaId ?? r.club?.eaId), Number(r.league?.eaId ?? r.club?.leagueEaId), Number(r.nation?.eaId),
    pos, [pos, ...(r.alternativePositionIds || [])].map(Number).filter(Number.isFinite),
    r.commonName || r.nickname || [r.firstName, r.lastName].filter(Boolean).join(' ') || String(id),
  ];
}
const FIELDS = ['definitionId', 'rating', 'rareflag', 'teamId', 'leagueId', 'nationId', 'preferredPosition', 'possiblePositions', 'name'];

let lastFetch = 0, failures = 0, requests = 0;
async function query(filters, pages) {
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const wait = GAP_MS - (Date.now() - lastFetch);
    if (wait > 0) await sleep(wait);
    lastFetch = Date.now();
    const url = new URL(PLAYERS_API);
    url.searchParams.set('page', String(page));
    url.searchParams.set('sorts', 'current_price');
    url.searchParams.set('price__gte', '200');
    for (const [k, v] of Object.entries(filters)) url.searchParams.set(k, String(v));
    requests++;
    try {
      const json = await getJson(url, 2);
      const data = Array.isArray(json?.data) ? json.data : [];
      for (const r of data) { const x = row(r); if (x) out.push(x); }
      if (!data.length) break;
    } catch (e) {
      failures++;
      log('query failed', JSON.stringify(filters), e.message);
      if (failures >= MAX_FAILURES) throw new Error(`Too many FUT.GG failures (${failures}) — keeping the previous database`);
      await sleep(5000);
      break;
    }
  }
  return out;
}

async function previous() {
  if (!PREV_URL) return [];
  try {
    const prev = await getJson(`${PREV_URL}/db.json`, 1);
    if (prev?.year === YEAR && Array.isArray(prev.players)) { log(`previous db: ${prev.players.length} players`); return prev.players; }
  } catch (e) { log('no previous db', e.message); }
  return [];
}

const topBy = (players, idx, n) => {
  const c = new Map();
  for (const p of players.values()) c.set(p[idx], (c.get(p[idx]) || 0) + 1);
  return [...c.entries()].filter(([k]) => Number.isFinite(k)).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
};

async function main() {
  const t0 = Date.now();
  const { table, map } = await buildPrices();

  const players = new Map();
  for (const p of await previous()) players.set(p[0], p);

  // 1) cheapest cards at every rating
  for (let r = 45; r <= 91; r++) {
    for (const p of await query({ overall__gte: r, overall__lte: r }, 3)) players.set(p[0], p);
  }
  log(`after rating crawl: ${players.size} players`);
  // 2) cheapest per league and per nation, in rating bands (for chemistry / league / nation SBCs)
  for (const lg of topBy(players, 4, 30)) {
    for (const [a, b] of [[45, 64], [65, 74], [75, 79], [80, 83], [84, 99]]) {
      for (const p of await query({ league_id: lg, overall__gte: a, overall__lte: b }, 1)) players.set(p[0], p);
    }
  }
  log(`after league crawl: ${players.size} players`);
  for (const na of topBy(players, 5, 40)) {
    for (const [a, b] of [[65, 74], [75, 79], [80, 83], [84, 99]]) {
      for (const p of await query({ nation_id: na, overall__gte: a, overall__lte: b }, 1)) players.set(p[0], p);
    }
  }
  log(`after nation crawl: ${players.size} players (${requests} requests, ${failures} failures)`);

  // Keep players that can actually be bought (tradable with a price on either platform).
  const list = [...players.values()].filter((p) => { const x = map.get(p[0]); return x && x.t && (x.c || x.p); });
  const builtAt = Date.now();
  await mkdir('public', { recursive: true });
  await writeFile('public/db.json', JSON.stringify({ v: 1, year: YEAR, builtAt, fields: FIELDS, players: list }));
  await writeFile('public/prices.json', JSON.stringify({ ...table, builtAt }));
  await writeFile('public/meta.json', JSON.stringify({ v: 1, year: YEAR, builtAt, players: list.length, prices: table.console.length }));
  await writeFile('public/index.html', `<!doctype html><meta charset="utf-8"><title>fut-sbc-db</title><p>FUT SBC Solver database — ${list.length} players, ${table.console.length} prices, built ${new Date(builtAt).toISOString()}.</p>`);
  log(`done in ${Math.round((Date.now() - t0) / 1000)} s: ${list.length} players, ${table.console.length} prices`);
}

main().catch((e) => { console.error(e); process.exit(1); });
