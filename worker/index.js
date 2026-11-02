// КиноВместе — версия сервера для Cloudflare Workers.
// Повторяет server.py: каталог Internet Archive, YouTube, субтитры и комнаты.
// Комната = Durable Object; синхронизация через WebSocket (комната «спит» между событиями)
// или запасной канал Server-Sent Events, действия — POST. Реестр комнат — отдельный Durable Object.
import { DurableObject } from "cloudflare:workers";
// страница встроена в Worker как текст — отдельная загрузка статики не нужна
import INDEX_HTML from "../static/index.html";
import ADMIN_HTML from "../static/admin.html";

const UA = { "User-Agent": "KinoVmeste/1.0 (watch-party; public-domain films)" };

const FEATURE_FILMS = "collection:(feature_films) AND mediatype:(movies)";

// Подборки со своей базовой коллекцией (заменяют FEATURE_FILMS)
const COLLECTIONS = {
  soviet: FEATURE_FILMS + ' AND (subject:(soviet OR ussr OR russian OR "советский") OR language:(rus OR russian))',
  cartoons: "mediatype:(movies) AND (collection:(classic_cartoons) OR " +
            "(collection:(animationandcartoons) AND year:[1900 TO 1960]))",
};

// Жанры -> поисковые запросы archive.org (внутри FEATURE_FILMS)
const GENRES = {
  horror: "subject:(horror)",
  comedy: "subject:(comedy)",
  scifi: 'subject:("science fiction" OR sci-fi)',
  western: "subject:(western)",
  noir: 'subject:("film noir" OR noir)',
  drama: "subject:(drama)",
  crime: "subject:(crime OR mystery)",
  silent: "subject:(silent)",
  war: "subject:(war)",
};

const REACTIONS = new Set(["😂", "😱", "❤️", "👍", "🔥", "😢", "🍿", "👏"]);
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const CYRILLIC = /[а-яё]/i;

// Кэш в памяти изолята (Cache API не работает на *.workers.dev)
const memo = new Map();

async function fetchJson(url, ttl = 600) {
  const hit = memo.get(url);
  if (hit && Date.now() - hit.at < ttl * 1000) return hit.data;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status} от ${new URL(url).host}`);
  const data = await r.json();
  if (memo.size > 500) memo.clear();
  memo.set(url, { at: Date.now(), data });
  return data;
}

const first = v => Array.isArray(v) ? v[0] : v;
const joined = v => Array.isArray(v) ? v.join(" ") : (v || "");

function stripHtml(s) {
  return String(s).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function unescapeHtml(s) {
  return String(s || "").replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, e) =>
    ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'" }[e]));
}

async function ruToEnTitles(q) {
  // Переводит русское название фильма в английское через Википедию
  const wiki = params => fetchJson("https://ru.wikipedia.org/w/api.php?" +
    new URLSearchParams({ ...params, format: "json" }), 86400);
  try {
    const found = await wiki({ action: "query", list: "search", srsearch: q + " фильм", srlimit: "5" });
    const titles = found.query.search.map(s => s.title);
    if (!titles.length) return [];
    const links = await wiki({ action: "query", titles: titles.join("|"), prop: "langlinks",
                               lllang: "en", lllimit: "50" });
    const out = [];
    for (const page of Object.values(links.query?.pages || {})) {
      for (const ll of page.langlinks || []) {
        const en = ll["*"].replace(/\s*\([^)]*\)$/, "").replaceAll('"', "").trim();
        if (en && !out.includes(en)) out.push(en);
      }
    }
    return out.slice(0, 5);
  } catch {
    return [];  // без перевода просто ищем как есть
  }
}

async function searchMovies(q, genre, page, sort) {
  const parts = [COLLECTIONS[genre] || FEATURE_FILMS];
  if (q) {
    const safe = q.replaceAll('"', " ").trim();
    const alts = CYRILLIC.test(safe)
      ? (await ruToEnTitles(safe)).map(t => ` OR title:("${t}")`).join("") : "";
    parts.push(`(title:(${safe}) OR subject:(${safe}) OR creator:(${safe})${alts})`);
  }
  if (GENRES[genre]) parts.push(GENRES[genre]);
  const sortField = { popular: "downloads desc", new: "addeddate desc",
                      year: "year desc", old: "year asc" }[sort] || "downloads desc";
  const params = new URLSearchParams([
    ["q", parts.join(" AND ")],
    ...["identifier", "title", "year", "downloads", "description"].map(f => ["fl[]", f]),
    ["sort[]", sortField], ["rows", "36"], ["page", String(page)], ["output", "json"],
  ]);
  const data = await fetchJson("https://archive.org/advancedsearch.php?" + params);
  const resp = data.response || {};
  return {
    total: resp.numFound || 0,
    items: (resp.docs || []).map(d => ({
      id: d.identifier,
      title: first(d.title) || d.identifier,
      year: d.year,
      downloads: d.downloads || 0,
      description: stripHtml(joined(d.description)).slice(0, 300),
    })),
  };
}

async function youtubeSearch(env, q, pageToken) {
  // Поиск полнометражных фильмов на YouTube (нужен YOUTUBE_API_KEY)
  const key = env.YOUTUBE_API_KEY;
  if (!key) return { error: "nokey" };
  q = q.trim() || "новый фильм полностью";
  if (!/фильм|movie|film|кино/i.test(q)) q += " фильм";
  const params = new URLSearchParams({
    part: "snippet", type: "video", videoDuration: "long", videoEmbeddable: "true",
    maxResults: "24", q, relevanceLanguage: "ru", safeSearch: "moderate", key,
  });
  if (pageToken) params.set("pageToken", pageToken);
  const data = await fetchJson("https://www.googleapis.com/youtube/v3/search?" + params, 3600);
  const items = [];
  for (const it of data.items || []) {
    const sn = it.snippet, vid = it.id?.videoId;
    if (!vid) continue;
    const th = sn.thumbnails || {};
    items.push({
      id: "yt:" + vid,
      title: unescapeHtml(sn.title),
      year: (sn.publishedAt || "").slice(0, 4),
      channel: unescapeHtml(sn.channelTitle),
      thumb: (th.high || th.medium || {}).url,
      description: unescapeHtml(sn.description),
    });
  }
  return { items, next: data.nextPageToken || null, total: data.pageInfo?.totalResults || 0 };
}

function youtubeIdFromLink(link) {
  const m = link.match(/(?:v=|youtu\.be\/|\/embed\/|\/shorts\/|\/live\/)([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  return YT_ID.test(link) ? link : null;
}

async function youtubeInfo(vid) {
  if (!YT_ID.test(vid)) return null;
  const watch = "https://www.youtube.com/watch?v=" + vid;
  let meta;
  try {  // oEmbed работает без ключа и отвечает ошибкой, если видео нельзя встроить
    meta = await fetchJson("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(watch), 86400);
  } catch {
    return null;
  }
  return { id: "yt:" + vid, title: meta.title || vid, year: "",
           description: "YouTube · " + (meta.author_name || ""),
           source: "youtube", ytId: vid, url: watch, subs: [] };
}

function subtitleLabel(name) {
  const low = name.toLowerCase();
  const asr = low.includes(".asr.") ? " (авто)" : "";
  for (const [code, label] of [["rus", "Русские"], [".ru.", "Русские"], ["eng", "English"], [".en.", "English"],
                               ["spa", "Español"], ["fre", "Français"], ["ger", "Deutsch"]]) {
    if (low.includes(code)) return label + asr;
  }
  return asr ? "English (авто)" : name.split("/").pop();
}

const RUTUBE_ID = /^[0-9a-f]{32}$/;
const VK_KEY = /^(-?\d{1,12})_(\d{1,12})(?:_([0-9a-f]{1,32}))?$/;

async function rutubeInfo(rid) {
  if (!RUTUBE_ID.test(rid)) return null;
  let meta;
  try {
    meta = await fetchJson("https://rutube.ru/api/oembed/?format=json&url=" +
                           encodeURIComponent(`https://rutube.ru/video/${rid}/`), 86400);
  } catch {
    return null;
  }
  return { id: "rt:" + rid, title: meta.title || "Видео Rutube", year: "",
           description: "Rutube · " + (meta.author_name || ""), thumb: meta.thumbnail_url,
           source: "rutube", embed: "https://rutube.ru/play/embed/" + rid,
           url: `https://rutube.ru/video/${rid}/`, subs: [] };
}

function vkInfo(key) {
  // VK отдаёт сведения о видео только браузеру, поэтому название общее
  const m = key.match(VK_KEY);
  if (!m) return null;
  const [, oid, vid, hash] = m;
  let embed = `https://vkvideo.ru/video_ext.php?oid=${oid}&id=${vid}&js_api=1`;
  if (hash) embed += "&hash=" + hash;
  return { id: "vk:" + key, title: "Видео VK", year: "", description: `VK Видео · video${oid}_${vid}`,
           source: "vk", embed, url: `https://vkvideo.ru/video${oid}_${vid}`, subs: [] };
}

async function infoFromLink(link) {
  // Ссылка на YouTube, Rutube или VK Видео -> данные для комнаты
  let m = link.match(/rutube\.ru\/(?:video|play\/embed|shorts)\/([0-9a-f]{32})/);
  if (m) return rutubeInfo(m[1]);
  m = link.match(/oid=(-?\d+)&(?:amp;)?id=(\d+)/) || link.match(/(?:vk\.com|vkvideo\.ru|vk\.ru)\/.*?video(-?\d+)_(\d+)/);
  if (m) {
    const h = link.match(/hash=([0-9a-f]+)/);
    return vkInfo(`${m[1]}_${m[2]}` + (h ? "_" + h[1] : ""));
  }
  const vid = youtubeIdFromLink(link);
  return vid ? youtubeInfo(vid) : null;
}

async function movieInfo(ident) {
  if (ident.startsWith("yt:")) return youtubeInfo(ident.slice(3));
  if (ident.startsWith("rt:")) return rutubeInfo(ident.slice(3));
  if (ident.startsWith("vk:")) return vkInfo(ident.slice(3));
  const data = await fetchJson("https://archive.org/metadata/" + encodeURIComponent(ident), 3600);
  const files = data.files || [], meta = data.metadata || {};
  const score = f => {
    const name = (f.name || "").toLowerCase(), fmt = (f.format || "").toLowerCase();
    if (!/\.(mp4|ogv|webm)$/.test(name)) return -1;
    let s = 0;
    if (name.endsWith(".mp4")) s += 100;
    if (fmt.includes("h.264")) s += 50;
    if (name.includes("512kb") || fmt.includes("512kb")) s += 10;  // лёгкая версия — хороший запасной вариант
    s += Math.min(Math.floor((parseInt(f.size, 10) || 0) / 50_000_000), 40);  // чем больше, тем качественнее
    return s;
  };
  let best = null;
  for (const f of files) if (score(f) >= 0 && (!best || score(f) > score(best))) best = f;
  if (!best) return null;
  const subs = files.filter(f => /\.(srt|vtt)$/i.test(f.name || "")).map(f => ({
    label: subtitleLabel(f.name),
    url: `/api/subs/${encodeURIComponent(ident)}/${encodeURIComponent(f.name)}`,
  }));
  return {
    id: ident,
    title: first(meta.title) || ident,
    year: meta.year || String(meta.date || "").slice(0, 4),
    description: stripHtml(joined(meta.description)).slice(0, 1200),
    url: `https://archive.org/download/${encodeURIComponent(ident)}/${encodeURIComponent(best.name)}`,
    subs,
  };
}

async function fetchSubtitles(ident, name) {
  // Скачивает .srt/.vtt с archive.org и отдаёт в формате WebVTT
  if (!/\.(srt|vtt)$/i.test(name)) return null;
  const r = await fetch(`https://archive.org/download/${encodeURIComponent(ident)}/${encodeURIComponent(name)}`,
                        { headers: UA });
  if (!r.ok) return null;
  const raw = await r.arrayBuffer();
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    try { text = new TextDecoder("windows-1251").decode(raw); }
    catch { text = new TextDecoder().decode(raw); }
  }
  text = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  // таймкоды в виде 00:00:45,77 -> 00:00:45.770 (WebVTT требует ровно 3 цифры)
  text = text.replace(/(\d{2}:\d{2}:\d{2})[.,](\d{1,3})\b/g, (_, t, ms) => `${t}.${ms.padEnd(3, "0")}`);
  return text.trimStart().startsWith("WEBVTT") ? text : "WEBVTT\n\n" + text;
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { "Content-Type": "application/json; charset=utf-8" },
});

function newRoomId() {
  const b = crypto.getRandomValues(new Uint8Array(5));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}


// ---------------- Комнаты ----------------

const enc = new TextEncoder();

class Forbidden extends Error {}

const CONTROL_ACTIONS = new Set(["load", "play", "pause", "seek", "countdown", "sync", "break"]);
const MOVIE_ID = /^[\w.:-]{1,160}$/;
const LEAVE_GRACE = 20_000;   // столько ждём переподключения, прежде чем написать «вышел»
const PING_TIMEOUT = 150_000; // клиент шлёт ping раз в 25 с; дольше тишины — соединение мёртвое
const WS_OPEN = 1;

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.clients = new Map();  // запасной канал SSE: client_id -> { name, writer, admin, lag }
    this.roomId = null;
    this.movie = null;
    this.playing = false;
    this.position = 0;
    this.updated = Date.now();
    this.created = Date.now();
    this.lastActive = Date.now();
    this.emptySince = null;    // когда ушёл последний зритель
    this.chat = [];
    this.adminKey = null;  // секрет создателя комнаты
    this.everyone = true;  // могут ли все управлять просмотром
    this.presence = {};    // client_id -> { name, leftAt } — чтобы переподключение не писало «вышел/зашёл»
    this.proposals = [];   // фильмы, предложенные комнате: { id, title, by, votes: [имена] }
    this.history = [];     // что уже смотрели вместе
    this.breakUntil = null;  // «перерыв на 5 минут»: до какого времени
    this.timer = null;
    // на ping отвечает сам Cloudflare, не будя комнату: между событиями она «спит» и не тратит лимит
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    // состояние переживает и сон комнаты, и её перезапуск
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get("room");
      if (saved) Object.assign(this, saved);
      this.presence = (await ctx.storage.get("presence")) || {};
    });
  }

  save() {
    this.ctx.storage.put("room", {
      roomId: this.roomId, movie: this.movie, playing: this.playing, position: this.position,
      updated: this.updated, created: this.created, lastActive: this.lastActive, emptySince: this.emptySince,
      chat: this.chat, adminKey: this.adminKey, everyone: this.everyone,
      proposals: this.proposals, history: this.history, breakUntil: this.breakUntil,
    });
  }

  currentPosition() {
    return this.playing ? this.position + (Date.now() - this.updated) / 1000 : this.position;
  }

  // ставит фильм на паузу там, где он был в момент ms
  pauseAt(ms) {
    if (!this.playing) return;
    this.position += Math.max(0, ms - this.updated) / 1000;
    this.updated = ms;
    this.playing = false;
  }

  sockets() {
    return this.ctx.getWebSockets().filter(ws => ws.readyState === WS_OPEN && !ws.deserializeAttachment()?.gone);
  }

  // все, кто сейчас на связи: через WebSocket и через запасной SSE
  live() {
    return [...this.sockets().map(ws => ws.deserializeAttachment()),
            ...[...this.clients].map(([cid, c]) => ({ cid, name: c.name, admin: c.admin, lag: c.lag }))];
  }

  users() {
    return [...new Set(this.live().map(c => c.name))].sort();
  }

  adminName() {
    return this.live().find(c => c.admin)?.name ?? null;
  }

  // кто сильно отстаёт от комнаты (медленный интернет): имя -> секунды
  lags() {
    return Object.fromEntries(this.live().filter(c => c.lag > 0).map(c => [c.name, c.lag]));
  }

  // сколько секунд осталось до конца перерыва (часы у всех разные — шлём остаток, а не время)
  breakLeft() {
    if (!this.breakUntil || this.playing) return null;
    const left = (this.breakUntil - Date.now()) / 1000;
    return left > -3600 ? left : null;
  }

  state() {
    return { type: "state", movie: this.movie, playing: this.playing,
             position: this.currentPosition(), users: this.users(), everyone: this.everyone,
             admin: this.adminName(), lags: this.lags(), breakLeft: this.breakLeft() };
  }

  extras() {
    return { type: "extras", proposals: this.proposals, history: this.history };
  }

  // сводка для панели администратора сайта
  snapshot() {
    return { users: this.users(), admin: this.adminName(),
             movie: this.movie && { id: this.movie.id, title: this.movie.title, source: this.movie.source || "archive" },
             playing: this.playing, position: this.position, updated: this.updated, everyone: this.everyone,
             created: this.created, lastActive: this.lastActive };
  }

  // реестр обновляем только по событиям (вход, выход, пуск, пауза…), а не по таймеру
  report() {
    if (!this.roomId || !this.env.REGISTRY) return;
    const reg = this.env.REGISTRY.get(this.env.REGISTRY.idFromName("all"));
    reg.update(this.roomId, this.snapshot()).catch(() => {});
  }

  // время из запроса; пустое или неверное значение не должно отматывать всех в начало
  positionFrom(body) {
    const v = body.position;
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : this.currentPosition();
  }

  isAdmin(key) {
    return Boolean(key) && key === this.adminKey;
  }

  sendTo(cid, client, msg) {
    client.writer.write(enc.encode(`data: ${JSON.stringify(msg)}\n\n`)).catch(() => this.drop(cid, client));
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.sockets()) { try { ws.send(data); } catch {} }
    for (const [cid, c] of this.clients) this.sendTo(cid, c, msg);
  }

  broadcastUsers() {
    this.broadcast({ type: "users", users: this.users(), admin: this.adminName(), lags: this.lags() });
  }

  // закрывает старое соединение того же клиента (обновил страницу — пришёл новым)
  replace(cid) {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a?.cid !== cid || a.gone) continue;
      ws.serializeAttachment({ ...a, gone: true });
      try { ws.close(4000, "replaced"); } catch {}
    }
    const old = this.clients.get(cid);
    if (old) { this.clients.delete(cid); old.writer.close().catch(() => {}); }
  }

  // вход: возвращает true, если это переподключение и писать «зашёл» не нужно
  join(cid, name) {
    const now = Date.now();
    // комната «застряла» в режиме просмотра без зрителей (например, после перезапуска) — ставим на паузу
    if (!this.live().some(c => c.cid !== cid) && this.playing && now - this.lastActive > 5 * 60_000) {
      this.pauseAt(this.lastActive);
    }
    let back = cid in this.presence;
    if (!back) {  // закрыл вкладку и открыл снова — новый id, но то же имя
      const same = Object.entries(this.presence).find(([, p]) => p.leftAt != null && p.name === name);
      if (same) { delete this.presence[same[0]]; back = true; }
    }
    this.presence[cid] = { name, leftAt: null };
    const ids = Object.keys(this.presence);
    if (ids.length > 60) for (const k of ids.slice(0, ids.length - 60)) delete this.presence[k];
    this.emptySince = null;
    this.lastActive = now;
    this.ctx.storage.put("presence", this.presence);
    return back;
  }

  greet(send, admin) {
    send({ type: "you", admin });
    send(this.state());
    send(this.extras());
    for (const m of this.chat.slice(-30)) send(m);
  }

  announce(name, back) {
    if (!back) this.broadcast({ type: "system", text: `${name} зашёл(а) в комнату` });
    this.broadcastUsers();
    this.save();
    this.report();
  }

  // выход: «вышел» напишем позже, если человек не вернётся за LEAVE_GRACE
  async leave(cid, name) {
    if (this.live().some(c => c.cid === cid)) return;  // уже переподключился
    if (this.presence[cid]?.leftAt != null) return;
    const now = Date.now();
    this.presence[cid] = { name, leftAt: now };
    this.lastActive = now;
    if (!this.live().length) this.emptySince = now;
    this.ctx.storage.put("presence", this.presence);
    const alarm = await this.ctx.storage.getAlarm();
    if (!alarm || alarm > now + LEAVE_GRACE) this.ctx.storage.setAlarm(now + LEAVE_GRACE);
    this.broadcastUsers();
    this.save();
    this.report();
  }

  // закрывает соединения, которые давно молчат (телефон потерял сеть и т.п.)
  async sweep() {
    const now = Date.now();
    for (const ws of this.sockets()) {
      const a = ws.deserializeAttachment();
      const last = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? a.at ?? now;
      if (now - Math.max(last, a.at ?? 0) < PING_TIMEOUT) continue;
      ws.serializeAttachment({ ...a, gone: true });
      try { ws.close(4001, "timeout"); } catch {}
      await this.leave(a.cid, a.name);
    }
  }

  async alarm() {
    await this.sweep();
    const now = Date.now(), live = new Set(this.live().map(c => c.cid));
    let changed = false, next = null;
    for (const [cid, p] of Object.entries(this.presence)) {
      if (p.leftAt == null || live.has(cid)) continue;
      if (now - p.leftAt >= LEAVE_GRACE - 1000) {
        delete this.presence[cid];
        changed = true;
        if (!this.users().includes(p.name)) this.broadcast({ type: "system", text: `${p.name} вышел(а)` });
      } else next = Math.min(next ?? Infinity, p.leftAt + LEAVE_GRACE);
    }
    // все разошлись — фильм встаёт на паузу там, где ушёл последний
    if (!live.size && this.emptySince && this.playing) { this.pauseAt(this.emptySince); this.save(); this.report(); }
    if (changed) this.ctx.storage.put("presence", this.presence);
    if (next) this.ctx.storage.setAlarm(next);
  }

  // реестр просит свежие данные (кнопка «Проверить» в панели администратора)
  async refresh() {
    await this.sweep();
    return this.snapshot();
  }

  async webSocketMessage() {
    // ping/pong отвечает Cloudflare сам; действия приходят POST-запросами
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code === 1005 ? 1000 : code, reason); } catch {}
    const a = ws.deserializeAttachment();
    if (a && !a.gone) await this.leave(a.cid, a.name);
  }

  async webSocketError(ws) {
    const a = ws.deserializeAttachment();
    if (a && !a.gone) await this.leave(a.cid, a.name);
  }

  drop(cid, client) {
    if (this.clients.get(cid) !== client) return;  // клиент уже переподключился новым соединением
    this.clients.delete(cid);
    client.writer.close().catch(() => {});
    if (!this.clients.size) { clearInterval(this.timer); this.timer = null; }
    this.leave(cid, client.name);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/room\/([\w-]{1,64})\//);
    if (m && this.roomId !== m[1]) { this.roomId = m[1]; this.save(); }
    if (url.pathname.endsWith("/ws")) return this.wsConnect(request, url);
    if (url.pathname.endsWith("/events")) return this.events(url);
    if (request.method === "POST" && url.pathname.endsWith("/action")) {
      let body;
      try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      try {
        await this.action(body);
      } catch (e) {
        if (e instanceof Forbidden) return json({ error: e.message, forbidden: true }, 403);
        return json({ error: String(e.message || e) }, 502);
      }
      return json({ ok: true });
    }
    return new Response("Not found", { status: 404 });
  }

  clientParams(url) {
    const cid = (url.searchParams.get("client") || crypto.randomUUID().slice(0, 8)).slice(0, 40);
    const name = (url.searchParams.get("name") || "Гость").slice(0, 30);
    const key = (url.searchParams.get("admin") || "").slice(0, 64);
    if (key && this.adminKey === null) { this.adminKey = key; this.save(); }  // первым с секретом приходит создатель
    return { cid, name, admin: this.isAdmin(key) };
  }

  // основной канал: WebSocket, который не держит комнату «проснувшейся»
  wsConnect(request, url) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
    const { cid, name, admin } = this.clientParams(url);
    this.replace(cid);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ cid, name, admin, at: Date.now() });
    const back = this.join(cid, name);
    this.greet(msg => server.send(JSON.stringify(msg)), admin);
    this.announce(name, back);
    return new Response(null, { status: 101, webSocket: client });
  }

  // запасной канал: Server-Sent Events (если WebSocket недоступен)
  events(url) {
    const { cid, name, admin } = this.clientParams(url);
    this.replace(cid);
    const { readable, writable } = new TransformStream();
    const client = { name, writer: writable.getWriter(), admin };
    this.clients.set(cid, client);
    const back = this.join(cid, name);
    this.greet(msg => this.sendTo(cid, client, msg), admin);
    this.announce(name, back);

    // SSE-клиентам время подстраиваем как раньше; отвалившиеся отсеиваются
    this.timer ??= setInterval(() => { for (const [id, c] of this.clients) this.sendTo(id, c, this.state()); }, 5000);

    return new Response(readable, { headers: {
      "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no",
    } });
  }

  async action(body) {
    const t = body.type;
    const name = String(body.name || "Гость").slice(0, 30);
    const admin = this.isAdmin(body.admin);
    if (CONTROL_ACTIONS.has(t) && !this.everyone && !admin) {
      throw new Forbidden("Сейчас просмотром управляет только администратор комнаты");
    }
    let sysMsg = null;
    if (t === "load") {
      // данные фильма берём с источника сами, а не доверяем клиенту
      const info = await movieInfo(String(body.id || ""));
      if (!info) throw new Error("у этого фильма нет видеофайла");
      this.movie = Object.fromEntries(["id", "title", "year", "url", "subs", "source", "ytId", "embed"]
        .map(k => [k, info[k] ?? null]));
      this.playing = false;
      this.position = 0;
      this.breakUntil = null;
      // предложение выполнено, а фильм попадает в историю комнаты
      this.proposals = this.proposals.filter(p => p.id !== this.movie.id);
      this.history = [{ id: this.movie.id, title: this.movie.title, source: this.movie.source || "archive",
                        by: name, at: Date.now() }, ...this.history.filter(h => h.id !== this.movie.id)].slice(0, 20);
      this.broadcast(this.extras());
      sysMsg = `${name} включил(а) «${this.movie.title}»`;
    } else if (t === "play") {
      this.position = this.positionFrom(body);
      this.playing = true;
      this.breakUntil = null;
      sysMsg = `${name}: ▶ пуск`;
    } else if (t === "pause") {
      this.position = this.positionFrom(body);
      this.playing = false;
      sysMsg = `${name}: ⏸ пауза`;
    } else if (t === "seek") {
      this.position = this.positionFrom(body);
    } else if (t === "syncreq") {
      // зритель просит администратора прислать своё точное время
      this.broadcast({ type: "syncreq", name });
      return;
    } else if (t === "sync") {
      this.position = this.positionFrom(body);
      this.playing = Boolean(body.playing);
      sysMsg = `🔄 Все синхронизированы по ${name}`;
    } else if (t === "countdown") {
      // общий отсчёт «3-2-1»: ставим на паузу, а запуск пришлёт тот, кто начал отсчёт
      this.position = this.positionFrom(body);
      this.playing = false;
      this.broadcast({ type: "countdown", name });
      sysMsg = `${name} запустил(а) обратный отсчёт ⏱`;
    } else if (t === "break") {
      // перерыв: пауза у всех и общий таймер
      const min = Math.min(30, Math.max(1, Math.round(Number(body.minutes) || 5)));
      this.position = this.positionFrom(body);
      this.playing = false;
      this.breakUntil = Date.now() + min * 60_000;
      sysMsg = `☕ ${name} объявил(а) перерыв на ${min} мин`;
    } else if (t === "typing") {
      this.broadcast({ type: "typing", name, client: body.client });
      return;
    } else if (t === "lag") {
      // клиент сообщает, только когда начал или перестал отставать — это редкое событие
      const lag = Math.min(36000, Math.max(0, Math.round(Number(body.lag) || 0)));
      for (const ws of this.sockets()) {
        const a = ws.deserializeAttachment();
        if (a.cid === body.client) ws.serializeAttachment({ ...a, lag });
      }
      const client = this.clients.get(body.client);
      if (client) client.lag = lag;
      this.broadcastUsers();
      return;
    } else if (t === "propose" || t === "vote" || t === "unpropose") {
      const id = String(body.id || "");
      if (!MOVIE_ID.test(id)) return;
      const p = this.proposals.find(x => x.id === id);
      if (t === "propose" && !p) {
        const title = String(body.title || "").trim().slice(0, 120) || "Фильм";
        this.proposals = [...this.proposals, { id, title, by: name, votes: [name] }].slice(-8);
        this.broadcast({ type: "system", text: `🗳 ${name} предлагает «${title}»` });
      } else if (t === "propose" && p) {
        if (!p.votes.includes(name)) p.votes = [...p.votes, name];
      } else if (t === "vote" && p) {
        // голос «за» — повторное нажатие снимает голос
        p.votes = p.votes.includes(name) ? p.votes.filter(v => v !== name) : [...p.votes, name];
      } else if (t === "unpropose" && p && (admin || p.by === name)) {
        this.proposals = this.proposals.filter(x => x !== p);
      } else return;
      this.broadcast(this.extras());
      this.save();
      return;
    } else if (t === "mode") {
      if (!admin) throw new Forbidden("Переключать режим может только администратор");
      this.position = this.currentPosition();  // время ниже обновится — не теряем позицию
      this.everyone = Boolean(body.everyone);
      sysMsg = this.everyone ? "Администратор разрешил всем управлять просмотром"
                             : "Администратор оставил управление просмотром только себе";
    } else if (t === "chat") {
      const text = String(body.text || "").trim().slice(0, 500);
      if (!text) return;
      const msg = { type: "chat", name, text, ts: Date.now() / 1000 };
      this.chat = [...this.chat, msg].slice(-100);
      this.broadcast(msg);
      this.save();
      return;
    } else if (t === "react") {
      if (REACTIONS.has(body.emoji)) this.broadcast({ type: "react", emoji: body.emoji, name });
      return;
    } else if (t === "rename") {
      const nw = String(body.new || "").trim().slice(0, 30);
      let old = null;
      for (const ws of this.sockets()) {
        const a = ws.deserializeAttachment();
        if (a.cid === body.client && nw && nw !== a.name) { old = a.name; ws.serializeAttachment({ ...a, name: nw }); }
      }
      const client = this.clients.get(body.client);
      if (client && nw && nw !== client.name) { old = client.name; client.name = nw; }
      if (old) {
        if (this.presence[body.client]) this.presence[body.client].name = nw;
        this.broadcast({ type: "system", text: `${old} теперь ${nw}` });
        this.broadcastUsers();
        this.report();
      }
      return;
    } else {
      return;
    }
    this.updated = Date.now();
    this.lastActive = this.updated;
    this.broadcast({ ...this.state(), by: body.client });
    if (sysMsg) this.broadcast({ type: "system", text: sysMsg });
    this.save();
    this.report();
  }
}

// ---------------- Реестр комнат (для панели администратора) ----------------

const DAY_MS = 86_400_000;
// бесплатный план: 13 000 ГБ·с в сутки, комната занимает 128 МБ — около 28 часов работы
const FREE_ROOM_HOURS = 28;

export class Registry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    ctx.blockConcurrencyWhile(async () => {
      this.rooms = (await ctx.storage.get("rooms")) || {};
      this.usage = (await ctx.storage.get("usage")) || { day: 0, ms: 0 };
    });
  }

  // лимит Cloudflare обнуляется в полночь по UTC
  rollover(now) {
    const day = Math.floor(now / DAY_MS);
    if (this.usage.day !== day) this.usage = { day, ms: 0 };
    return day * DAY_MS;
  }

  async update(id, info) {
    const now = Date.now(), dayStart = this.rollover(now);
    const prev = this.rooms[id];
    const was = prev?.users?.length > 0, is = info.users.length > 0;
    let activeSince = prev?.activeSince ?? null;
    // «комнато-часы»: сколько времени в комнате кто-то был
    if (was && !is) { this.usage.ms += now - Math.max(activeSince ?? now, dayStart); activeSince = null; }
    if (!was && is) activeSince = now;
    this.rooms[id] = { ...info, id, activeSince, seen: now };
    for (const [k, r] of Object.entries(this.rooms)) {  // давно пустые комнаты забываем
      if (!r.users.length && now - r.seen > 3 * DAY_MS) delete this.rooms[k];
    }
    await this.ctx.storage.put({ rooms: this.rooms, usage: this.usage });
  }

  async list() {
    const now = Date.now(), dayStart = this.rollover(now);
    let ms = this.usage.ms;
    for (const r of Object.values(this.rooms)) {
      if (r.users.length && r.activeSince) ms += now - Math.max(r.activeSince, dayStart);
    }
    const rooms = Object.values(this.rooms).sort((a, b) => b.users.length - a.users.length || b.seen - a.seen);
    return { now, rooms, usage: { roomHours: ms / 3_600_000, limitHours: FREE_ROOM_HOURS } };
  }

  // спрашивает «живые» комнаты напрямую — на случай, если реестр что-то пропустил
  async refreshAll() {
    const active = Object.values(this.rooms).filter(r => r.users.length);
    await Promise.all(active.map(async r => {
      try { await this.update(r.id, await this.env.ROOMS.get(this.env.ROOMS.idFromName(r.id)).refresh()); }
      catch {}
    }));
    return this.list();
  }
}

// ---------------- Панель администратора сайта ----------------

const ADMIN_TTL = 12 * 3600;  // вход действует 12 часов

async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" },
                                            false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(text));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// сравнение за постоянное время: по нему нельзя угадывать пароль побуквенно
function sameText(a, b) {
  const x = enc.encode(a), y = enc.encode(b);
  return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
}

async function adminToken(env, exp) {
  return `${exp}.${await hmacHex(env.ADMIN_PASSWORD, "kv-admin:" + exp)}`;
}

async function isAdminSession(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)kv_admin=(\d+)\.([0-9a-f]{64})/);
  if (!m || Number(m[1]) < Date.now() / 1000) return false;
  return sameText(await adminToken(env, m[1]), `${m[1]}.${m[2]}`);
}

function adminCookie(url, value, maxAge) {
  return `kv_admin=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}` +
         (url.protocol === "https:" ? "; Secure" : "");
}

async function adminApi(request, env, url) {
  const p = url.pathname;
  const enabled = Boolean(env.ADMIN_PASSWORD);
  if (p === "/api/admin/status") return json({ enabled, authed: await isAdminSession(request, env) });
  if (!enabled) return json({ error: "disabled" }, 503);
  if (p === "/api/admin/login" && request.method === "POST") {
    let body = {};
    try { body = await request.json(); } catch {}
    const ok = sameText(await hmacHex("kv-pw", String(body.password || "")), await hmacHex("kv-pw", env.ADMIN_PASSWORD));
    if (!ok) {
      await new Promise(r => setTimeout(r, 600));  // перебор паролей — медленнее
      return json({ error: "Неверный пароль" }, 401);
    }
    const exp = Math.floor(Date.now() / 1000) + ADMIN_TTL;
    return new Response(JSON.stringify({ ok: true }), { headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": adminCookie(url, await adminToken(env, exp), ADMIN_TTL) } });
  }
  if (p === "/api/admin/logout" && request.method === "POST") {
    return new Response(JSON.stringify({ ok: true }), { headers: {
      "Content-Type": "application/json; charset=utf-8", "Set-Cookie": adminCookie(url, "", 0) } });
  }
  if (!(await isAdminSession(request, env))) return json({ error: "auth" }, 401);
  if (p === "/api/admin/rooms") {
    const reg = env.REGISTRY.get(env.REGISTRY.idFromName("all"));
    return json(url.searchParams.get("refresh") ? await reg.refreshAll() : await reg.list());
  }
  return json({ error: "not found" }, 404);
}

// ---------------- HTTP ----------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname, qs = url.searchParams;
    try {
      if (p === "/api/search") {
        const page = Math.max(1, parseInt(qs.get("page") || "1", 10) || 1);
        return json(await searchMovies(qs.get("q") || "", qs.get("genre") || "", page, qs.get("sort") || "popular"));
      }
      if (p === "/api/yt/search") return json(await youtubeSearch(env, qs.get("q") || "", qs.get("page") || ""));
      if (p === "/api/link") {
        const info = await infoFromLink((qs.get("url") || "").trim());
        if (!info) return json({ error: "Не получилось открыть ссылку: нужна ссылка на видео " +
                                        "YouTube, VK Видео или Rutube" }, 404);
        return json(info);
      }
      if (p.startsWith("/api/movie/")) {
        const info = await movieInfo(decodeURIComponent(p.slice("/api/movie/".length)));
        return info ? json(info) : json({ error: "У этого фильма нет видеофайла" }, 404);
      }
      if (p.startsWith("/api/subs/")) {
        const [ident, ...rest] = p.slice("/api/subs/".length).split("/");
        const vtt = await fetchSubtitles(decodeURIComponent(ident), decodeURIComponent(rest.join("/")));
        if (vtt == null) return new Response("Not found", { status: 404 });
        return new Response(vtt, { headers: {
          "Content-Type": "text/vtt; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
      }
      if (p === "/api/new-room") return json({ id: newRoomId() });
      if (p.startsWith("/api/admin/")) return await adminApi(request, env, url);
      const m = p.match(/^\/api\/room\/([\w-]{1,64})\/(events|action|ws)$/);
      if (m) return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(request);
    } catch (e) {
      return json({ error: String(e.message || e) }, 502);
    }
    const html = text => new Response(text, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (p === "/" || p.startsWith("/room/")) return html(INDEX_HTML);
    if (p === "/admin" || p === "/admin/") return html(ADMIN_HTML);
    return new Response("Not found", { status: 404 });
  },
};
