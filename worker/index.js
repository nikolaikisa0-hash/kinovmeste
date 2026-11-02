// КиноВместе — версия сервера для Cloudflare Workers.
// Повторяет server.py: каталог Internet Archive, YouTube, субтитры и комнаты.
// Комната = Durable Object; синхронизация через WebSocket (комната «спит» между событиями)
// или запасной канал Server-Sent Events, действия — POST. Реестр комнат — отдельный Durable Object.
import { DurableObject } from "cloudflare:workers";
// страница встроена в Worker как текст — отдельная загрузка статики не нужна
import INDEX_HTML from "../static/index.html";
import ADMIN_HTML from "../static/admin.html";
import ICON_192 from "../static/icon-192.png";
import ICON_512 from "../static/icon-512.png";
import ICON_APPLE from "../static/apple-touch-icon.png";

// «значок на телефоне»: сайт открывается как приложение
const MANIFEST = JSON.stringify({
  name: "КиноВместе", short_name: "КиноВместе", lang: "ru", start_url: "/", scope: "/", display: "standalone",
  background_color: "#0b0b10", theme_color: "#0b0b10", description: "Смотрите фильмы вместе с друзьями",
  icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }],
});
const ICONS = { "/icon-192.png": ICON_192, "/icon-512.png": ICON_512, "/apple-touch-icon.png": ICON_APPLE };

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

async function rutubeSearch(q, page) {
  // поиск по Rutube — публичный, без ключа. Только официальные каналы (Мосфильм, телеканалы, студии):
  // обычные загрузки там часто пиратские, а их мы не показываем
  q = q.trim() || "Мосфильм";
  const data = await fetchJson("https://rutube.ru/api/search/video/?" +
    new URLSearchParams({ query: q, page: String(page) }), 1800);
  const items = (data.results || []).filter(r => r.is_official && !r.is_adult && RUTUBE_ID.test(r.id || "")).map(r => ({
    id: "rt:" + r.id, title: r.title || "Видео Rutube", year: String(r.publication_ts || "").slice(0, 4),
    channel: r.author?.name || "", thumb: r.thumbnail_url, duration: r.duration || 0,
    description: stripHtml(r.description || "").slice(0, 300),
  }));
  return { items, next: data.has_next ? String(page + 1) : null, total: data.count || items.length };
}

async function wikiAbout(title, year, strict) {
  // краткое описание фильма из русской Википедии (поиск понимает и английские названия).
  // strict — для Rutube/YouTube: год там — дата загрузки, а название бывает любым, поэтому проверяем строже
  if (strict) year = String(title).match(/\b(19\d{2}|20\d{2})\b/)?.[1] || "";
  const clean = String(title).replace(/\s*[([].*?[)\]]\s*/g, " ").replace(/[|«»"]/g, " ").trim().slice(0, 120);
  if (!clean) return null;
  try {
    const found = await fetchJson("https://ru.wikipedia.org/w/api.php?" + new URLSearchParams({
      action: "query", list: "search", srsearch: `${clean} ${year || ""} фильм`.trim(), srlimit: "1", format: "json" }), 86400);
    const page = found.query?.search?.[0]?.title;
    if (!page) return null;
    const sum = await fetchJson("https://ru.wikipedia.org/api/rest_v1/page/summary/" +
                                encodeURIComponent(page.replaceAll(" ", "_")), 86400);
    if (!sum.extract || sum.type === "disambiguation") return null;
    // статья точно про этот фильм? (иначе лучше ничего, чем чужое описание)
    const norm = t => String(t).toLowerCase().replace(/\s*\(.*?\)\s*/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (strict) {
      const a = norm(sum.title), b = norm(clean);
      if (!a || !(b.includes(a) || a.includes(b))) return null;
    } else if (year && !`${sum.description} ${sum.extract}`.includes(String(year))) return null;
    return { title: sum.title, description: sum.description || "", extract: sum.extract.slice(0, 900),
             url: sum.content_urls?.desktop?.page || "", image: sum.thumbnail?.source || null };
  } catch {
    return null;
  }
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
  // лёгкая версия для медленного интернета (если она есть и это не тот же файл)
  const lite = files.find(f => /512kb.*\.mp4$/i.test(f.name || "") && f.name !== best.name);
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
    lite: lite ? `https://archive.org/download/${encodeURIComponent(ident)}/${encodeURIComponent(lite.name)}` : null,
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

const CONTROL_ACTIONS = new Set(["load", "play", "pause", "seek", "countdown", "sync", "break", "readycheck", "schedule"]);
const MOVIE_ID = /^[\w.:-]{1,160}$/;
const MSG_REACTS = new Set(["👍", "❤️", "😂", "😮", "😢", "🔥"]);
const AVATAR = /^\p{Extended_Pictographic}[\u{1F3FB}-\u{1F3FF}\u200d\ufe0f\p{Extended_Pictographic}]{0,6}$/u;
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
    this.schedule = null;    // сеанс по расписанию: когда начинаем
    this.title = "";         // название комнаты, например «Пятничное кино»
    this.pinned = null;      // 📌 закреплённое сообщение: { id, name, text }
    this.banned = {};        // кого выгнали: client_id или «n:имя» -> до какого времени
    this.session = null;     // для «итогов вечера»: { movieId, startedAt, messages, reacts, talk }
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
      schedule: this.schedule, banned: this.banned, session: this.session, title: this.title, pinned: this.pinned,
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
            ...[...this.clients].map(([cid, c]) => ({ cid, name: c.name, admin: c.admin, lag: c.lag, av: c.av }))];
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

  // свои аватарки-эмодзи: имя -> эмодзи
  avatars() {
    return Object.fromEntries(this.live().filter(c => c.av).map(c => [c.name, c.av]));
  }

  // отправить сообщение всем соединениям человека с таким именем
  sendToName(name, msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.sockets()) if (ws.deserializeAttachment().name === name) { try { ws.send(data); } catch {} }
    for (const [cid, c] of this.clients) if (c.name === name) this.sendTo(cid, c, msg);
  }

  isBanned(cid, name) {
    const now = Date.now();
    for (const [k, until] of Object.entries(this.banned)) if (until < now) delete this.banned[k];
    return Boolean(this.banned[cid] || this.banned["n:" + name]);
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
             admin: this.adminName(), lags: this.lags(), breakLeft: this.breakLeft(), avatars: this.avatars(),
             scheduleLeft: this.schedule && !this.playing ? (this.schedule - Date.now()) / 1000 : null,
             roomTitle: this.title };
  }

  extras() {
    return { type: "extras", proposals: this.proposals, history: this.history, pinned: this.pinned };
  }

  // сводка для панели администратора сайта
  snapshot() {
    return { users: this.users(), admin: this.adminName(), title: this.title,
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
    this.broadcast({ type: "users", users: this.users(), admin: this.adminName(), lags: this.lags(), avatars: this.avatars() });
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
  async leave(cid, name, wasAdmin) {
    if (this.live().some(c => c.cid === cid)) return;  // уже переподключился
    if (this.presence[cid]?.leftAt != null) return;
    const now = Date.now();
    // управлять может только админ, а он пропал со связи — пауза, чтобы фильм не ушёл без него
    if (wasAdmin && !this.everyone && this.playing && !this.live().some(c => c.admin)) {
      this.pauseAt(now);
      this.broadcast(this.state());
      this.broadcast({ type: "system", text: "⏸ Администратор пропал со связи — пауза, ждём его" });
    }
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
      await this.leave(a.cid, a.name, a.admin);
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

  // команды из панели администратора сайта
  async siteAdmin(action, text) {
    if (action === "announce") {
      this.broadcast({ type: "announce", text: String(text || "").trim().slice(0, 300) });
      return { ok: true };
    }
    if (action === "close") {
      // всех вежливо выпроваживаем и забываем комнату целиком
      this.broadcast({ type: "closed" });
      for (const ws of this.ctx.getWebSockets()) {
        ws.serializeAttachment({ ...ws.deserializeAttachment(), gone: true });
        try { ws.close(4002, "closed"); } catch {}
      }
      for (const [, c] of this.clients) c.writer.close().catch(() => {});
      this.clients.clear();
      clearInterval(this.timer); this.timer = null;
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      Object.assign(this, { movie: null, playing: false, position: 0, chat: [], adminKey: null, everyone: true,
                            presence: {}, proposals: [], history: [], breakUntil: null, schedule: null,
                            banned: {}, session: null, title: "", pinned: null });
      return { ok: true };
    }
    return { error: "unknown action" };
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
    if (a && !a.gone) await this.leave(a.cid, a.name, a.admin);
  }

  async webSocketError(ws) {
    const a = ws.deserializeAttachment();
    if (a && !a.gone) await this.leave(a.cid, a.name, a.admin);
  }

  drop(cid, client) {
    if (this.clients.get(cid) !== client) return;  // клиент уже переподключился новым соединением
    this.clients.delete(cid);
    client.writer.close().catch(() => {});
    if (!this.clients.size) { clearInterval(this.timer); this.timer = null; }
    this.leave(cid, client.name, client.admin);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/room\/([\w-]{1,64})\//);
    if (m && this.roomId !== m[1]) { this.roomId = m[1]; this.save(); }
    if (url.pathname.endsWith("/ws")) return this.wsConnect(request, url);
    if (url.pathname.endsWith("/events")) return this.events(url);
    // занят ли адрес (для красивых ссылок на комнату)
    if (url.pathname.endsWith("/info")) return json({ taken: Boolean(this.adminKey || this.movie || this.chat.length) });
    if (request.method === "POST" && url.pathname.endsWith("/action")) {
      let body;
      try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      try {
        const res = await this.action(body);
        return json(res || { ok: true });
      } catch (e) {
        if (e instanceof Forbidden) return json({ error: e.message, forbidden: true }, 403);
        return json({ error: String(e.message || e) }, 502);
      }
    }
    return new Response("Not found", { status: 404 });
  }

  clientParams(url) {
    const cid = (url.searchParams.get("client") || crypto.randomUUID().slice(0, 8)).slice(0, 40);
    const name = (url.searchParams.get("name") || "Гость").slice(0, 30);
    const key = (url.searchParams.get("admin") || "").slice(0, 64);
    if (key && this.adminKey === null) { this.adminKey = key; this.save(); }  // первым с секретом приходит создатель
    const av = url.searchParams.get("avatar") || "";
    return { cid, name, admin: this.isAdmin(key), av: AVATAR.test(av) ? av : "" };
  }

  // основной канал: WebSocket, который не держит комнату «проснувшейся»
  wsConnect(request, url) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
    const { cid, name, admin, av } = this.clientParams(url);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    if (this.isBanned(cid, name)) {  // выгнанный админом не возвращается сразу
      server.serializeAttachment({ cid, name, gone: true });
      server.send(JSON.stringify({ type: "kicked" }));
      server.close(4003, "kicked");
      return new Response(null, { status: 101, webSocket: client });
    }
    this.replace(cid);
    server.serializeAttachment({ cid, name, admin, av, at: Date.now() });
    const back = this.join(cid, name);
    this.greet(msg => server.send(JSON.stringify(msg)), admin);
    this.announce(name, back);
    return new Response(null, { status: 101, webSocket: client });
  }

  // запасной канал: Server-Sent Events (если WebSocket недоступен)
  events(url) {
    const { cid, name, admin, av } = this.clientParams(url);
    const { readable, writable } = new TransformStream();
    if (this.isBanned(cid, name)) {
      const w = writable.getWriter();
      w.write(enc.encode(`data: ${JSON.stringify({ type: "kicked" })}\n\n`)).then(() => w.close()).catch(() => {});
      return new Response(readable, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
    }
    this.replace(cid);
    const client = { name, writer: writable.getWriter(), admin, av };
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
    // выгнанный не может писать и управлять даже напрямую, мимо страницы
    if (this.isBanned(String(body.client || ""), name)) throw new Forbidden("Вас удалили из этой комнаты");
    if (CONTROL_ACTIONS.has(t) && !this.everyone && !admin) {
      throw new Forbidden("Сейчас просмотром управляет только администратор комнаты");
    }
    let sysMsg = null;
    if (t === "load") {
      // данные фильма берём с источника сами, а не доверяем клиенту
      const info = await movieInfo(String(body.id || ""));
      if (!info) throw new Error("у этого фильма нет видеофайла");
      this.movie = Object.fromEntries(["id", "title", "year", "url", "lite", "subs", "source", "ytId", "embed"]
        .map(k => [k, info[k] ?? null]));
      // VK не отдаёт название видео серверу — его можно задать самим
      const own = String(body.title || "").replace(/\s+/g, " ").trim().slice(0, 120);
      if (info.source === "vk" && own) this.movie.title = own;
      this.playing = false;
      this.position = 0;
      this.breakUntil = null;
      // предложение выполнено, а фильм попадает в историю комнаты
      this.proposals = this.proposals.filter(p => p.id !== this.movie.id);
      this.history = [{ id: this.movie.id, title: this.movie.title, source: this.movie.source || "archive",
                        by: name, at: Date.now() }, ...this.history.filter(h => h.id !== this.movie.id)].slice(0, 20);
      this.broadcast(this.extras());
      this.session = { movieId: this.movie.id, startedAt: null, messages: 0, reacts: {}, talk: {} };
      sysMsg = `${name} включил(а) «${this.movie.title}»`;
    } else if (t === "play") {
      this.position = this.positionFrom(body);
      this.playing = true;
      this.breakUntil = null;
      this.schedule = null;
      if (this.session && !this.session.startedAt) this.session.startedAt = Date.now();
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
      this.schedule = null;  // отсчёт пошёл — расписание выполнено
      this.broadcast({ type: "countdown", name });
      sysMsg = `${name} запустил(а) обратный отсчёт ⏱`;
    } else if (t === "schedule") {
      // 🗓 сеанс по расписанию: время в секундах от «сейчас» — часы у всех разные
      const sec = Number(body.in);
      this.schedule = Number.isFinite(sec) && sec > 0 && sec < 7 * 86400 ? Date.now() + sec * 1000 : null;
      this.position = this.currentPosition();
      this.playing = false;
      sysMsg = this.schedule ? `🗓 ${name} назначил(а) сеанс` : `${name} отменил(а) сеанс`;
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
    } else if (t === "readycheck" || t === "ready") {
      // «Все готовы?»: сервер только передаёт сигнал, запуск делает тот, кто спросил
      this.broadcast({ type: t, name, client: body.client });
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
    } else if (t === "pin") {
      // 📌 закрепить сообщение над чатом (или открепить, если id пустой)
      if (!admin) throw new Forbidden("Закреплять сообщения может только администратор");
      const msg = body.id && this.chat.find(m => m.id === body.id);
      this.pinned = msg ? { id: msg.id, name: msg.name, text: msg.text.slice(0, 300) } : null;
      if (msg) this.broadcast({ type: "system", text: `📌 ${name} закрепил(а) сообщение` });
      this.broadcast(this.extras());
      this.save();
      return;
    } else if (t === "title") {
      if (!admin) throw new Forbidden("Название меняет только администратор");
      this.title = String(body.title || "").replace(/\s+/g, " ").trim().slice(0, 40);
      this.position = this.currentPosition();
      sysMsg = this.title ? `✏️ Комната теперь называется «${this.title}»` : "Название комнаты убрано";
    } else if (t === "mode") {
      if (!admin) throw new Forbidden("Переключать режим может только администратор");
      this.position = this.currentPosition();  // время ниже обновится — не теряем позицию
      this.everyone = Boolean(body.everyone);
      sysMsg = this.everyone ? "Администратор разрешил всем управлять просмотром"
                             : "Администратор оставил управление просмотром только себе";
    } else if (t === "chat") {
      const text = String(body.text || "").trim().slice(0, 500);
      if (!text) return;
      const msg = { type: "chat", id: crypto.randomUUID().slice(0, 8), name, text, ts: Date.now() / 1000 };
      const to = body.reply && this.chat.find(m => m.id === body.reply);
      if (to) msg.reply = { id: to.id, name: to.name, text: to.text.slice(0, 80) };  // ответ на сообщение
      if (this.session) {
        this.session.messages++;
        this.session.talk[name] = (this.session.talk[name] || 0) + 1;
      }
      this.chat = [...this.chat, msg].slice(-100);
      this.broadcast(msg);
      this.save();
      return;
    } else if (t === "react") {
      if (!REACTIONS.has(body.emoji)) return;
      this.broadcast({ type: "react", emoji: body.emoji, name });
      if (this.session) { this.session.reacts[body.emoji] = (this.session.reacts[body.emoji] || 0) + 1; this.save(); }
      return;
    } else if (t === "msgreact") {
      // реакция на сообщение в чате; повторное нажатие снимает её
      const msg = this.chat.find(m => m.id === body.id);
      if (!msg || !MSG_REACTS.has(body.emoji)) return;
      const r = { ...(msg.reactions || {}) }, who = r[body.emoji] || [];
      r[body.emoji] = who.includes(name) ? who.filter(n => n !== name) : [...who, name];
      if (!r[body.emoji].length) delete r[body.emoji];
      msg.reactions = r;
      this.broadcast({ type: "msgreact", id: msg.id, reactions: r });
      this.save();
      return;
    } else if (t === "avatar") {
      const av = String(body.avatar || "");
      for (const ws of this.sockets()) {
        const a = ws.deserializeAttachment();
        if (a.cid === body.client) ws.serializeAttachment({ ...a, av: AVATAR.test(av) ? av : "" });
      }
      const c = this.clients.get(body.client);
      if (c) c.av = AVATAR.test(av) ? av : "";
      this.broadcastUsers();
      return;
    } else if (t === "giveadmin" || t === "kick") {
      if (!admin) throw new Forbidden("Это может только администратор комнаты");
      const target = String(body.target || "").slice(0, 30);
      if (!target || target === name || !this.users().includes(target)) return;
      if (t === "giveadmin") {
        // корона переходит вместе с новым секретом: у старого админа он больше не действует
        this.adminKey = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
        for (const ws of this.sockets()) {
          const a = ws.deserializeAttachment();
          ws.serializeAttachment({ ...a, admin: a.name === target });
        }
        for (const [, c] of this.clients) c.admin = c.name === target;
        this.sendToName(target, { type: "adminkey", key: this.adminKey });
        for (const u of this.users()) this.sendToName(u, { type: "you", admin: u === target });
        this.broadcast({ type: "system", text: `👑 ${name} передал(а) корону: теперь администратор — ${target}` });
      } else {
        // выгнать: на 10 минут нельзя вернуться ни с этой вкладки, ни под этим именем
        const until = Date.now() + 10 * 60_000;
        this.banned["n:" + target] = until;
        for (const ws of this.sockets()) {
          const a = ws.deserializeAttachment();
          if (a.name !== target) continue;
          this.banned[a.cid] = until;
          delete this.presence[a.cid];
          ws.serializeAttachment({ ...a, gone: true });
          try { ws.send(JSON.stringify({ type: "kicked" })); ws.close(4003, "kicked"); } catch {}
        }
        for (const [cid, c] of this.clients) {
          if (c.name !== target) continue;
          this.banned[cid] = until;
          delete this.presence[cid];
          this.sendTo(cid, c, { type: "kicked" });
          this.clients.delete(cid);
          c.writer.close().catch(() => {});
        }
        this.ctx.storage.put("presence", this.presence);
        this.broadcast({ type: "system", text: `${target} удалён(а) из комнаты` });
      }
      this.broadcastUsers();
      this.save();
      this.report();
      return;
    } else if (t === "rate") {
      // ⭐ оценка фильма — сохраняется в истории комнаты
      const stars = Math.round(Number(body.stars));
      if (!this.movie || !(stars >= 1 && stars <= 5)) return;
      let h = this.history.find(x => x.id === this.movie.id);
      if (!h) {  // фильм включили до того, как появилась история, — заводим запись сейчас
        h = { id: this.movie.id, title: this.movie.title, source: this.movie.source || "archive", by: name, at: Date.now() };
        this.history = [h, ...this.history].slice(0, 20);
      }
      h.ratings = { ...(h.ratings || {}), [name]: stars };
      this.broadcast(this.extras());
      this.save();
      return;
    } else if (t === "summary") {
      // «итоги вечера»: отдаём только тому, кто спросил
      const ss = this.session && this.movie && this.session.movieId === this.movie.id ? this.session : null;
      const h = this.movie && this.history.find(x => x.id === this.movie.id);
      return { ok: true, summary: ss && { ...ss, title: this.movie.title, position: this.currentPosition(),
                                          ratings: h?.ratings || {} } };
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
    this.broadcast({ ...this.state(), by: body.client, byName: name });  // byName — для «Вася поставил паузу»
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
      this.days = (await ctx.storage.get("days")) || [];  // итоги прошлых суток
      this.films = (await ctx.storage.get("films")) || {};  // что включали: id -> { title, source, n, last }
    });
  }

  // лимит Cloudflare обнуляется в полночь по UTC; итоги прошедших суток уходят в историю
  rollover(now) {
    const day = Math.floor(now / DAY_MS);
    if (this.usage.day !== day) {
      const u = this.usage;
      if (u.day) this.days = [...this.days, { day: u.day, hours: u.ms / 3_600_000, peak: u.peak || 0,
                                              rooms: (u.rooms || []).length, films: u.films || 0 }].slice(-30);
      this.usage = { day, ms: 0, peak: 0, rooms: [], films: 0 };
    }
    return day * DAY_MS;
  }

  async update(id, info) {
    const now = Date.now(), dayStart = this.rollover(now);
    const prev = this.rooms[id], u = this.usage;
    const was = prev?.users?.length > 0, is = info.users.length > 0;
    let activeSince = prev?.activeSince ?? null;
    // «комнато-часы»: сколько времени в комнате кто-то был
    if (was && !is) { u.ms += now - Math.max(activeSince ?? now, dayStart); activeSince = null; }
    if (!was && is) activeSince = now;
    this.rooms[id] = { ...info, id, activeSince, seen: now };
    // статистика дня: сколько комнат было, пик зрителей, сколько раз включали фильмы
    u.rooms ??= [];
    if (is && !u.rooms.includes(id) && u.rooms.length < 1000) u.rooms.push(id);
    u.peak = Math.max(u.peak || 0, Object.values(this.rooms).reduce((n, r) => n + r.users.length, 0));
    if (info.movie && info.movie.id !== prev?.movie?.id) {
      u.films = (u.films || 0) + 1;
      const f = this.films[info.movie.id] || { n: 0 };
      this.films[info.movie.id] = { title: info.movie.title, source: info.movie.source, n: f.n + 1, last: now };
      const ids = Object.keys(this.films);
      if (ids.length > 200) {  // храним только недавние
        ids.sort((a, b) => this.films[a].last - this.films[b].last).slice(0, ids.length - 200).forEach(k => delete this.films[k]);
      }
    }
    for (const [k, r] of Object.entries(this.rooms)) {  // давно пустые комнаты забываем
      if (!r.users.length && now - r.seen > 3 * DAY_MS) delete this.rooms[k];
    }
    await this.ctx.storage.put({ rooms: this.rooms, usage: this.usage, days: this.days, films: this.films });
  }

  async remove(id) {
    const r = this.rooms[id];
    if (!r) return;
    if (r.users.length && r.activeSince) this.usage.ms += Date.now() - Math.max(r.activeSince, this.rollover(Date.now()));
    delete this.rooms[id];
    await this.ctx.storage.put({ rooms: this.rooms, usage: this.usage });
  }

  async list() {
    const now = Date.now(), dayStart = this.rollover(now), u = this.usage;
    let ms = u.ms;
    for (const r of Object.values(this.rooms)) {
      if (r.users.length && r.activeSince) ms += now - Math.max(r.activeSince, dayStart);
    }
    const rooms = Object.values(this.rooms).sort((a, b) => b.users.length - a.users.length || b.seen - a.seen);
    const today = { day: u.day, hours: ms / 3_600_000, peak: u.peak || 0, rooms: (u.rooms || []).length, films: u.films || 0 };
    const top = Object.entries(this.films).map(([id, f]) => ({ id, ...f }))
      .sort((a, b) => b.n - a.n || b.last - a.last).slice(0, 8);
    return { now, rooms, usage: { roomHours: today.hours, limitHours: FREE_ROOM_HOURS },
             today, days: [...this.days.slice(-13), today], top };
  }

  // «смотрят в КиноВместе»: самые включаемые фильмы за неделю (только названия — без комнат и имён)
  async topWeek() {
    const since = Date.now() - 7 * DAY_MS;
    return Object.entries(this.films).filter(([, f]) => f.last > since)
      .map(([id, f]) => ({ id, title: f.title, source: f.source, n: f.n }))
      .sort((a, b) => b.n - a.n).slice(0, 12);
  }

  // сколько людей и комнат сейчас на сайте — только числа, без имён
  async online() {
    const active = Object.values(this.rooms).filter(r => r.users.length);
    return { viewers: active.reduce((n, r) => n + r.users.length, 0), rooms: active.length };
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
  if (p === "/api/admin/room" && request.method === "POST") {
    let body = {};
    try { body = await request.json(); } catch {}
    const id = String(body.id || "");
    if (!/^[\w-]{1,64}$/.test(id) || !["announce", "close"].includes(body.action)) return json({ error: "bad request" }, 400);
    if (body.action === "announce" && !String(body.text || "").trim()) return json({ error: "Пустое сообщение" }, 400);
    const res = await env.ROOMS.get(env.ROOMS.idFromName(id)).siteAdmin(body.action, body.text);
    if (body.action === "close") await env.REGISTRY.get(env.REGISTRY.idFromName("all")).remove(id);
    return json(res);
  }
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
      if (p === "/api/rutube/search") {
        return json(await rutubeSearch(qs.get("q") || "", Math.max(1, parseInt(qs.get("page") || "1", 10) || 1)));
      }
      if (p === "/api/wiki") return json(await wikiAbout(qs.get("title") || "", qs.get("year") || "", qs.get("strict") === "1") || {});
      if (p === "/api/top") {
        // держим в памяти минуту, чтобы не будить реестр на каждое открытие главной
        const hit = memo.get("top");
        if (hit && Date.now() - hit.at < 60_000) return json(hit.data);
        const reg = env.REGISTRY.get(env.REGISTRY.idFromName("all"));
        const data = { items: await reg.topWeek(), online: await reg.online() };
        memo.set("top", { at: Date.now(), data });
        return json(data);
      }
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
      const m = p.match(/^\/api\/room\/([\w-]{1,64})\/(events|action|ws|info)$/);
      if (m) return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(request);
    } catch (e) {
      return json({ error: String(e.message || e) }, 502);
    }
    const html = text => new Response(text, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (p === "/" || p.startsWith("/room/")) return html(INDEX_HTML);
    if (p === "/admin" || p === "/admin/") return html(ADMIN_HTML);
    if (p === "/manifest.webmanifest") {
      return new Response(MANIFEST, { headers: { "Content-Type": "application/manifest+json; charset=utf-8" } });
    }
    if (ICONS[p]) return new Response(ICONS[p], { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" } });
    return new Response("Not found", { status: 404 });
  },
};
