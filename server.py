#!/usr/bin/env python3
"""КиноВместе — сервер для совместного просмотра.

Каталог: фильмы в общественном достоянии из Internet Archive (archive.org).
Синхронизация: Server-Sent Events (сервер -> клиенты) + POST (клиент -> сервер).
Только стандартная библиотека Python 3.8+.
"""
import html
import json
import os
import queue
import re
import secrets
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "static")
PORT = int(os.environ.get("PORT", "8000"))
UA = {"User-Agent": "KinoVmeste/1.0 (watch-party; public-domain films)"}

FEATURE_FILMS = "collection:(feature_films) AND mediatype:(movies)"

# Подборки со своей базовой коллекцией (заменяют FEATURE_FILMS)
COLLECTIONS = {
    "soviet": FEATURE_FILMS + ' AND (subject:(soviet OR ussr OR russian OR "советский") OR language:(rus OR russian))',
    "cartoons": "mediatype:(movies) AND (collection:(classic_cartoons) OR "
                "(collection:(animationandcartoons) AND year:[1900 TO 1960]))",
}

# Жанры -> поисковые запросы archive.org (внутри FEATURE_FILMS)
GENRES = {
    "horror": 'subject:(horror)',
    "comedy": 'subject:(comedy)',
    "scifi": 'subject:("science fiction" OR sci-fi)',
    "western": 'subject:(western)',
    "noir": 'subject:("film noir" OR noir)',
    "drama": 'subject:(drama)',
    "crime": 'subject:(crime OR mystery)',
    "silent": 'subject:(silent)',
    "war": 'subject:(war)',
}

_cache = {}
_cache_lock = threading.Lock()


def fetch_json(url, ttl=600):
    now = time.time()
    with _cache_lock:
        hit = _cache.get(url)
        if hit and now - hit[0] < ttl:
            return hit[1]
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.loads(r.read().decode("utf-8"))
    with _cache_lock:
        _cache[url] = (now, data)
    return data


CYRILLIC = re.compile("[а-яё]", re.I)


def ru_to_en_titles(q):
    """Переводит русское название фильма в английское через Википедию."""
    def wiki(params):
        return fetch_json("https://ru.wikipedia.org/w/api.php?" + urllib.parse.urlencode(
            {**params, "format": "json"}), ttl=86400)
    try:
        found = wiki({"action": "query", "list": "search", "srsearch": q + " фильм", "srlimit": 5})
        titles = [s["title"] for s in found["query"]["search"]]
        if not titles:
            return []
        links = wiki({"action": "query", "titles": "|".join(titles), "prop": "langlinks",
                      "lllang": "en", "lllimit": 50})
    except Exception:  # noqa: BLE001 — без перевода просто ищем как есть
        return []
    out = []
    for page in links.get("query", {}).get("pages", {}).values():
        for ll in page.get("langlinks", []):
            en = re.sub(r"\s*\([^)]*\)$", "", ll.get("*", "")).replace('"', "").strip()
            if en and en not in out:
                out.append(en)
    return out[:5]


def search_movies(q, genre, page, sort):
    parts = [COLLECTIONS.get(genre, FEATURE_FILMS)]
    if q:
        safe = q.replace('"', " ").strip()
        alts = "".join(f' OR title:("{t}")' for t in ru_to_en_titles(safe)) if CYRILLIC.search(safe) else ""
        parts.append(f'(title:({safe}) OR subject:({safe}) OR creator:({safe}){alts})')
    if genre in GENRES:
        parts.append(GENRES[genre])
    sort_field = {"popular": "downloads desc", "new": "addeddate desc",
                  "year": "year desc", "old": "year asc"}.get(sort, "downloads desc")
    params = [
        ("q", " AND ".join(parts)),
        ("fl[]", "identifier"), ("fl[]", "title"), ("fl[]", "year"),
        ("fl[]", "downloads"), ("fl[]", "description"),
        ("sort[]", sort_field),
        ("rows", "36"), ("page", str(page)), ("output", "json"),
    ]
    url = "https://archive.org/advancedsearch.php?" + urllib.parse.urlencode(params)
    data = fetch_json(url)
    resp = data.get("response", {})
    items = []
    for d in resp.get("docs", []):
        desc = d.get("description") or ""
        if isinstance(desc, list):
            desc = " ".join(desc)
        title = d.get("title") or d["identifier"]
        if isinstance(title, list):
            title = title[0]
        items.append({
            "id": d["identifier"],
            "title": title,
            "year": d.get("year"),
            "downloads": d.get("downloads", 0),
            "description": strip_html(desc)[:300],
        })
    return {"total": resp.get("numFound", 0), "items": items}


def strip_html(s):
    out, tag = [], False
    for ch in s:
        if ch == "<":
            tag = True
        elif ch == ">":
            tag = False
        elif not tag:
            out.append(ch)
    return " ".join("".join(out).split())


YT_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


def youtube_search(q, page_token):
    """Поиск полнометражных фильмов на YouTube (нужен YOUTUBE_API_KEY)."""
    key = os.environ.get("YOUTUBE_API_KEY")
    if not key:
        return {"error": "nokey"}
    q = q.strip() or "новый фильм полностью"
    if not re.search(r"фильм|movie|film|кино", q, re.I):
        q += " фильм"
    params = {"part": "snippet", "type": "video", "videoDuration": "long",
              "videoEmbeddable": "true", "maxResults": "24", "q": q,
              "relevanceLanguage": "ru", "safeSearch": "moderate", "key": key}
    if page_token:
        params["pageToken"] = page_token
    data = fetch_json("https://www.googleapis.com/youtube/v3/search?" + urllib.parse.urlencode(params), ttl=3600)
    items = []
    for it in data.get("items", []):
        sn, vid = it["snippet"], it["id"].get("videoId")
        if not vid:
            continue
        thumbs = sn.get("thumbnails", {})
        items.append({
            "id": "yt:" + vid,
            "title": html.unescape(sn.get("title", "")),
            "year": sn.get("publishedAt", "")[:4],
            "channel": html.unescape(sn.get("channelTitle", "")),
            "thumb": (thumbs.get("high") or thumbs.get("medium") or {}).get("url"),
            "description": html.unescape(sn.get("description", "")),
        })
    return {"items": items, "next": data.get("nextPageToken"),
            "total": data.get("pageInfo", {}).get("totalResults", 0)}


def youtube_id_from_link(link):
    m = re.search(r"(?:v=|youtu\.be/|/embed/|/shorts/|/live/)([A-Za-z0-9_-]{11})", link)
    if m:
        return m.group(1)
    return link if YT_ID.match(link) else None


def youtube_info(vid):
    if not YT_ID.match(vid):
        return None
    watch = "https://www.youtube.com/watch?v=" + vid
    try:  # oEmbed работает без ключа и отвечает ошибкой, если видео нельзя встроить
        meta = fetch_json("https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote(watch), ttl=86400)
    except Exception:  # noqa: BLE001
        return None
    return {"id": "yt:" + vid, "title": meta.get("title", vid), "year": "",
            "description": "YouTube · " + meta.get("author_name", ""),
            "source": "youtube", "ytId": vid, "url": watch, "subs": []}


def movie_info(ident):
    if ident.startswith("yt:"):
        return youtube_info(ident[3:])
    data = fetch_json("https://archive.org/metadata/" + urllib.parse.quote(ident), ttl=3600)
    files = data.get("files", [])
    meta = data.get("metadata", {})

    def score(f):
        name = f.get("name", "").lower()
        fmt = f.get("format", "").lower()
        if not (name.endswith(".mp4") or name.endswith(".ogv") or name.endswith(".webm")):
            return -1
        s = 0
        if name.endswith(".mp4"):
            s += 100
        if "h.264" in fmt:
            s += 50
        if "512kb" in name or "512kb" in fmt:
            s += 10  # лёгкая версия — хороший запасной вариант
        try:
            s += min(int(f.get("size", 0)) // 50_000_000, 40)  # чем больше, тем качественнее
        except ValueError:
            pass
        return s

    best = max(files, key=score, default=None)
    if not best or score(best) < 0:
        return None
    title = meta.get("title", ident)
    if isinstance(title, list):
        title = title[0]
    desc = meta.get("description", "")
    if isinstance(desc, list):
        desc = " ".join(desc)
    subs = []
    for f in files:
        name = f.get("name", "")
        if name.lower().endswith((".srt", ".vtt")):
            subs.append({"label": subtitle_label(name),
                         "url": "/api/subs/%s/%s" % (urllib.parse.quote(ident), urllib.parse.quote(name))})
    return {
        "id": ident,
        "title": title,
        "year": meta.get("year") or meta.get("date", "")[:4],
        "description": strip_html(desc)[:1200],
        "url": "https://archive.org/download/%s/%s" % (
            urllib.parse.quote(ident), urllib.parse.quote(best["name"])),
        "subs": subs,
    }


def subtitle_label(name):
    low = name.lower()
    for code, label in (("rus", "Русские"), (".ru.", "Русские"), ("eng", "English"), (".en.", "English"),
                        ("spa", "Español"), ("fre", "Français"), ("ger", "Deutsch")):
        if code in low:
            return label + (" (авто)" if ".asr." in low else "")
    return "English (авто)" if ".asr." in low else name.rsplit("/", 1)[-1]


def fetch_subtitles(ident, name):
    """Скачивает .srt/.vtt с archive.org и отдаёт в формате WebVTT."""
    if not name.lower().endswith((".srt", ".vtt")):
        return None
    url = "https://archive.org/download/%s/%s" % (urllib.parse.quote(ident), urllib.parse.quote(name))
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=20) as r:
        raw = r.read()
    for enc in ("utf-8-sig", "cp1251", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    text = text.replace("\r\n", "\n")
    # таймкоды в виде 00:00:45,77 -> 00:00:45.770 (WebVTT требует ровно 3 цифры)
    text = re.sub(r"(\d{2}:\d{2}:\d{2})[.,](\d{1,3})\b",
                  lambda m: m.group(1) + "." + m.group(2).ljust(3, "0"), text)
    if text.lstrip().startswith("WEBVTT"):
        return text
    return "WEBVTT\n\n" + text


# ---------------- Комнаты ----------------

class Room:
    def __init__(self, rid):
        self.id = rid
        self.lock = threading.Lock()
        self.movie = None
        self.playing = False
        self.position = 0.0
        self.updated = time.time()
        self.clients = {}  # client_id -> {"name", "queue"}
        self.chat = []

    def current_position(self):
        if self.playing:
            return self.position + (time.time() - self.updated)
        return self.position

    def state(self):
        return {
            "type": "state",
            "movie": self.movie,
            "playing": self.playing,
            "position": self.current_position(),
            "users": sorted({c["name"] for c in self.clients.values()}),
        }

    def broadcast(self, msg):
        for c in list(self.clients.values()):
            c["queue"].put(msg)


rooms = {}
rooms_lock = threading.Lock()


def get_room(rid):
    with rooms_lock:
        if rid not in rooms:
            rooms[rid] = Room(rid)
        return rooms[rid]


REACTIONS = {"😂", "😱", "❤️", "👍", "🔥", "😢", "🍿", "👏"}


def room_action(room, body):
    t = body.get("type")
    name = str(body.get("name", "Гость"))[:30]
    info = None
    if t == "load":
        # данные фильма берём с archive.org сами, а не доверяем клиенту
        info = movie_info(str(body.get("id", "")))
        if not info:
            raise ValueError("у этого фильма нет видеофайла")
    with room.lock:
        if t == "load":
            room.movie = {k: info.get(k) for k in ("id", "title", "year", "url", "subs", "source", "ytId")}
            room.playing = False
            room.position = 0.0
            sys_msg = f"{name} включил(а) «{room.movie['title']}»"
        elif t == "play":
            room.position = float(body.get("position", room.current_position()))
            room.playing = True
            sys_msg = f"{name}: ▶ пуск"
        elif t == "pause":
            room.position = float(body.get("position", room.current_position()))
            room.playing = False
            sys_msg = f"{name}: ⏸ пауза"
        elif t == "seek":
            room.position = float(body.get("position", 0))
            sys_msg = None
        elif t == "chat":
            text = str(body.get("text", "")).strip()[:500]
            if not text:
                return
            msg = {"type": "chat", "name": name, "text": text, "ts": time.time()}
            room.chat = (room.chat + [msg])[-100:]
            room.broadcast(msg)
            return
        elif t == "react":
            if body.get("emoji") in REACTIONS:
                room.broadcast({"type": "react", "emoji": body["emoji"], "name": name})
            return
        elif t == "rename":
            client = room.clients.get(body.get("client"))
            new = str(body.get("new", "")).strip()[:30]
            if client and new and new != client["name"]:
                old, client["name"] = client["name"], new
                room.broadcast({"type": "system", "text": f"{old} теперь {new}"})
                room.broadcast({"type": "users", "users": sorted({c["name"] for c in room.clients.values()})})
            return
        else:
            return
        room.updated = time.time()
        st = room.state()
        st["by"] = body.get("client")
        room.broadcast(st)
        if sys_msg:
            room.broadcast({"type": "system", "text": sys_msg})


# ---------------- HTTP ----------------

class Handler(BaseHTTPRequestHandler):
    server_version = "KinoVmeste/1.0"

    def log_message(self, fmt, *args):
        if "/events" not in (args[0] if args else ""):
            super().log_message(fmt, *args)

    def send_json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_file(self, path, ctype):
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            return self.send_error(404)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(u.query)
        p = u.path
        try:
            if p == "/" or p.startswith("/room/"):
                return self.send_file(os.path.join(STATIC, "index.html"), "text/html; charset=utf-8")
            if p == "/api/search":
                page = max(1, int(qs.get("page", ["1"])[0]))
                return self.send_json(search_movies(
                    qs.get("q", [""])[0], qs.get("genre", [""])[0], page,
                    qs.get("sort", ["popular"])[0]))
            if p == "/api/yt/search":
                return self.send_json(youtube_search(qs.get("q", [""])[0], qs.get("page", [""])[0]))
            if p == "/api/link":
                vid = youtube_id_from_link(qs.get("url", [""])[0].strip())
                info = vid and youtube_info(vid)
                if not info:
                    return self.send_json({"error": "Не получилось открыть ссылку: нужна ссылка на видео YouTube, "
                                                    "которое разрешено встраивать"}, 404)
                return self.send_json(info)
            if p.startswith("/api/movie/"):
                info = movie_info(urllib.parse.unquote(p[len("/api/movie/"):]))
                if not info:
                    return self.send_json({"error": "У этого фильма нет видеофайла"}, 404)
                return self.send_json(info)
            if p.startswith("/api/subs/"):
                ident, _, name = p[len("/api/subs/"):].partition("/")
                vtt = fetch_subtitles(urllib.parse.unquote(ident), urllib.parse.unquote(name))
                if vtt is None:
                    return self.send_error(404)
                data = vtt.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/vtt; charset=utf-8")
                self.send_header("Cache-Control", "public, max-age=86400")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                return self.wfile.write(data)
            if p == "/api/new-room":
                return self.send_json({"id": secrets.token_urlsafe(5)})
            if p.startswith("/api/room/") and p.endswith("/events"):
                return self.sse(p.split("/")[3], qs)
        except Exception as e:  # noqa: BLE001
            return self.send_json({"error": str(e)}, 502)
        self.send_error(404)

    def do_POST(self):
        p = urllib.parse.urlparse(self.path).path
        if p.startswith("/api/room/") and p.endswith("/action"):
            length = int(self.headers.get("Content-Length", 0))
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                return self.send_json({"error": "bad json"}, 400)
            try:
                room_action(get_room(p.split("/")[3]), body)
            except Exception as e:  # noqa: BLE001
                return self.send_json({"error": str(e)}, 502)
            return self.send_json({"ok": True})
        self.send_error(404)

    def sse(self, rid, qs):
        room = get_room(rid)
        cid = qs.get("client", [secrets.token_hex(4)])[0]
        name = qs.get("name", ["Гость"])[0][:30]
        q = queue.Queue()
        with room.lock:
            room.clients[cid] = {"name": name, "queue": q}
            q.put(room.state())
            for m in room.chat[-30:]:
                q.put(m)
            room.broadcast({"type": "system", "text": f"{name} зашёл(а) в комнату"})
            room.broadcast({"type": "users", "users": sorted({c["name"] for c in room.clients.values()})})

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        try:
            while True:
                try:
                    msg = q.get(timeout=5)
                except queue.Empty:
                    # периодическая подстройка: клиенты догоняют расхождение
                    with room.lock:
                        msg = room.state()
                self.wfile.write(b"data: " + json.dumps(msg, ensure_ascii=False).encode() + b"\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with room.lock:
                me = room.clients.get(cid)
                if not me or me["queue"] is not q:
                    return  # клиент уже переподключился новым соединением
                name = me["name"]
                del room.clients[cid]
                room.broadcast({"type": "system", "text": f"{name} вышел(а)"})
                room.broadcast({"type": "users", "users": sorted({c["name"] for c in room.clients.values()})})


if __name__ == "__main__":
    try:
        srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    except OSError as e:
        if e.errno == 48 or "in use" in str(e):
            raise SystemExit(
                f"Порт {PORT} уже занят — скорее всего, сайт уже запущен: http://localhost:{PORT}\n"
                f"Остановить старый сервер: lsof -ti :{PORT} | xargs kill\n"
                f"Или запустить на другом порту: PORT=8001 python3 server.py")
        raise
    srv.daemon_threads = True
    print(f"КиноВместе запущен: http://localhost:{PORT}")
    srv.serve_forever()
