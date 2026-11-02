// КиноВместе — версия сервера для Cloudflare Workers.
// Повторяет server.py: каталог Internet Archive, YouTube, субтитры и комнаты.
// Комната = Durable Object; синхронизация через Server-Sent Events + POST.
import { DurableObject } from "cloudflare:workers";
// страница встроена в Worker как текст — отдельная загрузка статики не нужна
import INDEX_HTML from "../static/index.html";

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

async function movieInfo(ident) {
  if (ident.startsWith("yt:")) return youtubeInfo(ident.slice(3));
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

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.clients = new Map();  // client_id -> { name, writer }
    this.movie = null;
    this.playing = false;
    this.position = 0;
    this.updated = Date.now();
    this.chat = [];
    this.timer = null;
    // фильм и чат переживают перезапуск объекта
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get("room");
      if (saved) Object.assign(this, saved, { playing: false });
    });
  }

  save() {
    this.ctx.storage.put("room", { movie: this.movie, position: this.currentPosition(), chat: this.chat });
  }

  currentPosition() {
    return this.playing ? this.position + (Date.now() - this.updated) / 1000 : this.position;
  }

  users() {
    return [...new Set([...this.clients.values()].map(c => c.name))].sort();
  }

  state() {
    return { type: "state", movie: this.movie, playing: this.playing,
             position: this.currentPosition(), users: this.users() };
  }

  sendTo(cid, client, msg) {
    client.writer.write(enc.encode(`data: ${JSON.stringify(msg)}\n\n`)).catch(() => this.drop(cid, client));
  }

  broadcast(msg) {
    for (const [cid, c] of this.clients) this.sendTo(cid, c, msg);
  }

  drop(cid, client) {
    if (this.clients.get(cid) !== client) return;  // клиент уже переподключился новым соединением
    this.clients.delete(cid);
    client.writer.close().catch(() => {});
    this.broadcast({ type: "system", text: `${client.name} вышел(а)` });
    this.broadcast({ type: "users", users: this.users() });
    if (!this.clients.size) { clearInterval(this.timer); this.timer = null; this.save(); }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/events")) return this.events(url);
    if (request.method === "POST" && url.pathname.endsWith("/action")) {
      let body;
      try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      try { await this.action(body); } catch (e) { return json({ error: String(e.message || e) }, 502); }
      return json({ ok: true });
    }
    return new Response("Not found", { status: 404 });
  }

  events(url) {
    const cid = url.searchParams.get("client") || crypto.randomUUID().slice(0, 8);
    const name = (url.searchParams.get("name") || "Гость").slice(0, 30);
    const { readable, writable } = new TransformStream();
    const client = { name, writer: writable.getWriter() };
    const old = this.clients.get(cid);
    this.clients.set(cid, client);
    if (old) old.writer.close().catch(() => {});

    this.sendTo(cid, client, this.state());
    for (const m of this.chat.slice(-30)) this.sendTo(cid, client, m);
    this.broadcast({ type: "system", text: `${name} зашёл(а) в комнату` });
    this.broadcast({ type: "users", users: this.users() });

    // периодическая подстройка: клиенты догоняют расхождение, отвалившиеся отсеиваются
    this.timer ??= setInterval(() => this.broadcast(this.state()), 5000);

    return new Response(readable, { headers: {
      "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no",
    } });
  }

  async action(body) {
    const t = body.type;
    const name = String(body.name || "Гость").slice(0, 30);
    let sysMsg = null;
    if (t === "load") {
      // данные фильма берём с источника сами, а не доверяем клиенту
      const info = await movieInfo(String(body.id || ""));
      if (!info) throw new Error("у этого фильма нет видеофайла");
      this.movie = Object.fromEntries(["id", "title", "year", "url", "subs", "source", "ytId"]
        .map(k => [k, info[k] ?? null]));
      this.playing = false;
      this.position = 0;
      sysMsg = `${name} включил(а) «${this.movie.title}»`;
    } else if (t === "play") {
      this.position = Number(body.position ?? this.currentPosition());
      this.playing = true;
      sysMsg = `${name}: ▶ пуск`;
    } else if (t === "pause") {
      this.position = Number(body.position ?? this.currentPosition());
      this.playing = false;
      sysMsg = `${name}: ⏸ пауза`;
    } else if (t === "seek") {
      this.position = Number(body.position) || 0;
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
      const client = this.clients.get(body.client);
      const nw = String(body.new || "").trim().slice(0, 30);
      if (client && nw && nw !== client.name) {
        const old = client.name;
        client.name = nw;
        this.broadcast({ type: "system", text: `${old} теперь ${nw}` });
        this.broadcast({ type: "users", users: this.users() });
      }
      return;
    } else {
      return;
    }
    this.updated = Date.now();
    this.broadcast({ ...this.state(), by: body.client });
    if (sysMsg) this.broadcast({ type: "system", text: sysMsg });
    this.save();
  }
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
        const vid = youtubeIdFromLink((qs.get("url") || "").trim());
        const info = vid && await youtubeInfo(vid);
        if (!info) return json({ error: "Не получилось открыть ссылку: нужна ссылка на видео YouTube, " +
                                        "которое разрешено встраивать" }, 404);
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
      const m = p.match(/^\/api\/room\/([\w-]{1,64})\/(events|action)$/);
      if (m) return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(request);
    } catch (e) {
      return json({ error: String(e.message || e) }, 502);
    }
    if (p === "/" || p.startsWith("/room/")) {
      return new Response(INDEX_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return new Response("Not found", { status: 404 });
  },
};
