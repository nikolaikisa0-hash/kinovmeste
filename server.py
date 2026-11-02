#!/usr/bin/env python3
"""КиноВместе — сервер для совместного просмотра.

Каталог: фильмы в общественном достоянии из Internet Archive (archive.org).
Синхронизация: Server-Sent Events (сервер -> клиенты) + POST (клиент -> сервер).
Панель администратора сайта: /admin (пароль — переменная окружения ADMIN_PASSWORD).
Только стандартная библиотека Python 3.8+.
"""
import hashlib
import hmac
import html
import json
import math
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


def rutube_search(q, page):
    """Поиск по Rutube — публичный, без ключа. Только официальные каналы (Мосфильм, телеканалы, студии):
    обычные загрузки там часто пиратские, а их мы не показываем."""
    q = q.strip() or "Мосфильм"
    data = fetch_json("https://rutube.ru/api/search/video/?" + urllib.parse.urlencode(
        {"query": q, "page": page}), ttl=1800)
    items = []
    for r in data.get("results", []):
        if not r.get("is_official") or r.get("is_adult") or not RUTUBE_ID.match(r.get("id") or ""):
            continue
        items.append({"id": "rt:" + r["id"], "title": r.get("title") or "Видео Rutube",
                      "year": str(r.get("publication_ts") or "")[:4], "channel": (r.get("author") or {}).get("name", ""),
                      "thumb": r.get("thumbnail_url"), "duration": r.get("duration") or 0,
                      "description": strip_html(r.get("description") or "")[:300]})
    return {"items": items, "next": str(page + 1) if data.get("has_next") else None,
            "total": data.get("count") or len(items)}


def wiki_about(title, year, strict=False):
    """Краткое описание фильма из русской Википедии (поиск понимает и английские названия).
    strict — для Rutube/YouTube: год там — дата загрузки, а название бывает любым, поэтому проверяем строже."""
    if strict:
        m = re.search(r"\b(19\d{2}|20\d{2})\b", str(title))
        year = m.group(1) if m else ""
    clean = re.sub(r"\s*[(\[].*?[)\]]\s*", " ", str(title))
    clean = re.sub(r"[|«»\"]", " ", clean).strip()[:120]
    if not clean:
        return None
    try:
        found = fetch_json("https://ru.wikipedia.org/w/api.php?" + urllib.parse.urlencode({
            "action": "query", "list": "search", "srsearch": f"{clean} {year or ''} фильм".strip(),
            "srlimit": 1, "format": "json"}), ttl=86400)
        hits = found.get("query", {}).get("search", [])
        if not hits:
            return None
        s = fetch_json("https://ru.wikipedia.org/api/rest_v1/page/summary/" +
                       urllib.parse.quote(hits[0]["title"].replace(" ", "_")), ttl=86400)
    except Exception:  # noqa: BLE001
        return None
    if not s.get("extract") or s.get("type") == "disambiguation":
        return None
    # статья точно про этот фильм? (иначе лучше ничего, чем чужое описание)
    def norm(t):
        return re.sub(r"[\W_]+", " ", re.sub(r"\s*\(.*?\)\s*", " ", str(t).lower())).strip()
    if strict:
        a, b = norm(s.get("title", "")), norm(clean)
        if not a or not (a in b or b in a):
            return None
    elif year and str(year) not in f"{s.get('description', '')} {s['extract']}":
        return None
    return {"title": s.get("title"), "description": s.get("description", ""), "extract": s["extract"][:900],
            "url": s.get("content_urls", {}).get("desktop", {}).get("page", ""),
            "image": (s.get("thumbnail") or {}).get("source")}


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


RUTUBE_ID = re.compile(r"^[0-9a-f]{32}$")
VK_KEY = re.compile(r"^(-?\d{1,12})_(\d{1,12})(?:_([0-9a-f]{1,32}))?$")


def rutube_info(rid):
    if not RUTUBE_ID.match(rid):
        return None
    try:
        meta = fetch_json("https://rutube.ru/api/oembed/?format=json&url=" +
                          urllib.parse.quote("https://rutube.ru/video/%s/" % rid), ttl=86400)
    except Exception:  # noqa: BLE001
        return None
    return {"id": "rt:" + rid, "title": meta.get("title", "Видео Rutube"), "year": "",
            "description": "Rutube · " + meta.get("author_name", ""), "thumb": meta.get("thumbnail_url"),
            "source": "rutube", "embed": "https://rutube.ru/play/embed/" + rid,
            "url": "https://rutube.ru/video/%s/" % rid, "subs": []}


def vk_info(key):
    # VK отдаёт сведения о видео только браузеру, поэтому название общее
    m = VK_KEY.match(key)
    if not m:
        return None
    oid, vid, vhash = m.groups()
    embed = "https://vkvideo.ru/video_ext.php?oid=%s&id=%s&js_api=1" % (oid, vid)
    if vhash:
        embed += "&hash=" + vhash
    return {"id": "vk:" + key, "title": "Видео VK", "year": "",
            "description": "VK Видео · video%s_%s" % (oid, vid),
            "source": "vk", "embed": embed, "url": "https://vkvideo.ru/video%s_%s" % (oid, vid), "subs": []}


def info_from_link(link):
    """Ссылка на YouTube, Rutube или VK Видео -> данные для комнаты."""
    m = re.search(r"rutube\.ru/(?:video|play/embed|shorts)/([0-9a-f]{32})", link)
    if m:
        return rutube_info(m.group(1))
    m = (re.search(r"oid=(-?\d+)&(?:amp;)?id=(\d+)", link) or
         re.search(r"(?:vk\.com|vkvideo\.ru|vk\.ru)/.*?video(-?\d+)_(\d+)", link))
    if m:
        h = re.search(r"hash=([0-9a-f]+)", link)
        return vk_info("%s_%s" % m.groups() + ("_" + h.group(1) if h else ""))
    vid = youtube_id_from_link(link)
    return vid and youtube_info(vid)


def movie_info(ident):
    if ident.startswith("yt:"):
        return youtube_info(ident[3:])
    if ident.startswith("rt:"):
        return rutube_info(ident[3:])
    if ident.startswith("vk:"):
        return vk_info(ident[3:])
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
    # лёгкая версия для медленного интернета (если она есть и это не тот же файл)
    lite = next((f for f in files if re.search(r"512kb.*\.mp4$", f.get("name", ""), re.I)
                 and f.get("name") != best["name"]), None)
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
        "lite": lite and "https://archive.org/download/%s/%s" % (
            urllib.parse.quote(ident), urllib.parse.quote(lite["name"])),
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

LEAVE_GRACE = 20  # столько секунд ждём переподключения, прежде чем написать «вышел»


class Room:
    def __init__(self, rid):
        self.id = rid
        self.lock = threading.Lock()
        self.movie = None
        self.playing = False
        self.position = 0.0
        self.updated = time.time()
        self.created = time.time()
        self.last_active = time.time()
        self.empty_since = None  # когда ушёл последний зритель
        self.active_since = None  # с какого момента в комнате кто-то есть (для «комнато-часов»)
        self.clients = {}  # client_id -> {"name", "queue", "admin"}
        self.presence = {}  # client_id -> {"name", "left_at"} — чтобы переподключение не писало «вышел/зашёл»
        self.chat = []
        self.proposals = []  # фильмы, предложенные комнате: {"id", "title", "by", "votes": [имена]}
        self.history = []    # что уже смотрели вместе
        self.break_until = None  # «перерыв на 5 минут»: до какого времени
        self.schedule = None     # сеанс по расписанию: когда начинаем
        self.banned = {}         # кого выгнали: client_id или «n:имя» -> до какого времени
        self.session = None      # для «итогов вечера»
        self.admin_key = None   # секрет создателя комнаты
        self.everyone = True    # могут ли все управлять просмотром

    def current_position(self):
        if self.playing:
            return self.position + (time.time() - self.updated)
        return self.position

    def pause_at(self, t):
        """Ставит фильм на паузу там, где он был в момент t."""
        if self.playing:
            self.position += max(0.0, t - self.updated)
            self.updated = t
            self.playing = False

    def users(self):
        return sorted({c["name"] for c in self.clients.values()})

    def admin_name(self):
        return next((c["name"] for c in self.clients.values() if c["admin"]), None)

    def lags(self):
        """Кто сильно отстаёт от комнаты (медленный интернет): имя -> секунды."""
        return {c["name"]: c["lag"] for c in self.clients.values() if c.get("lag")}

    def break_left(self):
        """Сколько секунд осталось до конца перерыва (шлём остаток — часы у всех разные)."""
        if not self.break_until or self.playing:
            return None
        left = self.break_until - time.time()
        return left if left > -3600 else None

    def avatars(self):
        return {c["name"]: c["av"] for c in self.clients.values() if c.get("av")}

    def send_to_name(self, name, msg):
        for c in list(self.clients.values()):
            if c["name"] == name:
                c["queue"].put(msg)

    def is_banned(self, cid, name):
        now = time.time()
        for k in [k for k, until in self.banned.items() if until < now]:
            del self.banned[k]
        return cid in self.banned or "n:" + name in self.banned

    def extras(self):
        return {"type": "extras", "proposals": self.proposals, "history": self.history}

    def state(self):
        return {
            "type": "state",
            "movie": self.movie,
            "playing": self.playing,
            "position": self.current_position(),
            "users": self.users(),
            "everyone": self.everyone,
            "admin": self.admin_name(),
            "lags": self.lags(),
            "breakLeft": self.break_left(),
            "avatars": self.avatars(),
            "scheduleLeft": self.schedule - time.time() if self.schedule and not self.playing else None,
        }

    def snapshot(self):
        """Сводка для панели администратора сайта (время — в миллисекундах, как в Cloudflare-версии)."""
        m = self.movie
        return {
            "id": self.id, "users": self.users(), "admin": self.admin_name(),
            "movie": m and {"id": m["id"], "title": m["title"], "source": m.get("source") or "archive"},
            "playing": self.playing, "position": self.position, "updated": self.updated * 1000,
            "everyone": self.everyone, "created": self.created * 1000, "lastActive": self.last_active * 1000,
            "seen": self.last_active * 1000,
            "activeSince": self.active_since and self.active_since * 1000,
        }

    def broadcast_users(self):
        self.broadcast({"type": "users", "users": self.users(), "admin": self.admin_name(), "lags": self.lags(),
                        "avatars": self.avatars()})

    def is_admin(self, key):
        return bool(key) and key == self.admin_key

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


# «комнато-часы» за сутки (по UTC, как лимит Cloudflare) — для панели администратора
FREE_ROOM_HOURS = 28
usage = {"day": 0, "sec": 0.0, "peak": 0, "rooms": set(), "films": 0}
days = []    # итоги прошлых суток
films = {}   # что включали: id -> {"title", "source", "n", "last"}


def day_start(now):
    """Под rooms_lock. Итоги прошедших суток уходят в историю."""
    day = int(now // 86400)
    if usage["day"] != day:
        if usage["day"]:
            days.append({"day": usage["day"], "hours": usage["sec"] / 3600, "peak": usage["peak"],
                         "rooms": len(usage["rooms"]), "films": usage["films"]})
            del days[:-30]
        usage.update(day=day, sec=0.0, peak=0, rooms=set(), films=0)
    return day * 86400


def track_film(movie):
    """Вызывается при включении фильма — для «популярных фильмов» в панели."""
    with rooms_lock:
        day_start(time.time())
        usage["films"] += 1
        f = films.get(movie["id"], {"n": 0})
        films[movie["id"]] = {"title": movie["title"], "source": movie.get("source") or "archive",
                              "n": f["n"] + 1, "last": time.time() * 1000}
        if len(films) > 200:
            for k in sorted(films, key=lambda k: films[k]["last"])[:len(films) - 200]:
                del films[k]


def track_usage(room):
    """Вызывается под room.lock после входа или выхода."""
    now = time.time()
    with rooms_lock:
        start = day_start(now)
        if room.clients and room.active_since is None:
            room.active_since = now
        elif not room.clients and room.active_since is not None:
            usage["sec"] += now - max(room.active_since, start)
            room.active_since = None
        # статистика дня: сколько комнат было и пик зрителей
        if room.clients and len(usage["rooms"]) < 1000:
            usage["rooms"].add(room.id)
        usage["peak"] = max(usage["peak"], sum(len(r.clients) for r in rooms.values()))


def rooms_overview():
    now = time.time()
    with rooms_lock:
        start = day_start(now)
        sec = usage["sec"] + sum(now - max(r.active_since, start) for r in rooms.values() if r.active_since)
        all_rooms = list(rooms.values())
        today = {"day": usage["day"], "hours": sec / 3600, "peak": usage["peak"],
                 "rooms": len(usage["rooms"]), "films": usage["films"]}
        top = sorted(({"id": k, **f} for k, f in films.items()), key=lambda f: (-f["n"], -f["last"]))[:8]
        history = days[-13:] + [today]
    out = []
    for r in all_rooms:
        with r.lock:
            if r.clients or r.movie or now - r.last_active < 3 * 86400:
                out.append(r.snapshot())
    out.sort(key=lambda r: (-len(r["users"]), -r["seen"]))
    return {"now": now * 1000, "rooms": out,
            "usage": {"roomHours": sec / 3600, "limitHours": FREE_ROOM_HOURS},
            "today": today, "days": history, "top": top}


def site_admin(rid, action, text):
    """Команды из панели администратора сайта: объявление в комнату или закрыть её."""
    with rooms_lock:
        room = rooms.get(rid)
    if not room:
        return {"error": "Комната не найдена"}
    with room.lock:
        if action == "announce":
            room.broadcast({"type": "announce", "text": str(text or "").strip()[:300]})
            return {"ok": True}
        # всех вежливо выпроваживаем и забываем комнату целиком
        room.broadcast({"type": "closed"})
        room.clients.clear()
        room.presence.clear()
    with rooms_lock:
        if room.active_since:
            usage["sec"] += time.time() - max(room.active_since, day_start(time.time()))
        rooms.pop(rid, None)
    return {"ok": True}


def join_room(room, cid, name):
    """Вход (под room.lock); True — это переподключение, писать «зашёл» не нужно."""
    back = cid in room.presence
    if not back:  # закрыл вкладку и открыл снова — новый id, но то же имя
        same = next((k for k, p in room.presence.items() if p["left_at"] and p["name"] == name), None)
        if same:
            del room.presence[same]
            back = True
    room.presence[cid] = {"name": name, "left_at": None}
    room.empty_since = None
    room.last_active = time.time()
    return back


def finish_leave(room, cid):
    """Через LEAVE_GRACE после выхода: человек не вернулся — пишем «вышел»."""
    with room.lock:
        p = room.presence.get(cid)
        if not p or not p["left_at"] or cid in room.clients:
            return
        del room.presence[cid]
        if p["name"] not in room.users():
            room.broadcast({"type": "system", "text": f"{p['name']} вышел(а)"})
        # все разошлись — фильм встаёт на паузу там, где ушёл последний
        if not room.clients and room.empty_since:
            room.pause_at(room.empty_since)


REACTIONS = {"😂", "😱", "❤️", "👍", "🔥", "😢", "🍿", "👏"}


def position_from(body, room):
    """Время из запроса; пустое или неверное значение не должно отматывать всех в начало."""
    v = body.get("position")
    if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v >= 0:
        return float(v)
    return room.current_position()


class Forbidden(Exception):
    pass


CONTROL_ACTIONS = {"load", "play", "pause", "seek", "countdown", "sync", "break", "readycheck", "schedule"}
MSG_REACTS = {"👍", "❤️", "😂", "😮", "😢", "🔥"}


def valid_avatar(av):
    """Аватарка — одно эмодзи (с модификаторами), без букв и цифр."""
    av = str(av or "")
    return av if 0 < len(av) <= 8 and ord(av[0]) > 0x2000 and not any(ch.isalnum() or ch.isspace() for ch in av) else ""
MOVIE_ID = re.compile(r"^[\w.:-]{1,160}$")


def room_action(room, body):
    t = body.get("type")
    name = str(body.get("name", "Гость"))[:30]
    admin = room.is_admin(body.get("admin"))
    if t in CONTROL_ACTIONS and not room.everyone and not admin:
        raise Forbidden("Сейчас просмотром управляет только администратор комнаты")
    info = None
    if t == "load":
        # данные фильма берём с archive.org сами, а не доверяем клиенту
        info = movie_info(str(body.get("id", "")))
        if not info:
            raise ValueError("у этого фильма нет видеофайла")
    with room.lock:
        if t == "load":
            room.movie = {k: info.get(k) for k in ("id", "title", "year", "url", "lite", "subs", "source", "ytId", "embed")}
            room.playing = False
            room.position = 0.0
            room.break_until = None
            track_film(room.movie)
            # предложение выполнено, а фильм попадает в историю комнаты
            mid = room.movie["id"]
            room.proposals = [p for p in room.proposals if p["id"] != mid]
            room.history = ([{"id": mid, "title": room.movie["title"], "source": room.movie.get("source") or "archive",
                              "by": name, "at": time.time() * 1000}] +
                            [h for h in room.history if h["id"] != mid])[:20]
            room.broadcast(room.extras())
            room.session = {"movieId": mid, "startedAt": None, "messages": 0, "reacts": {}, "talk": {}}
            sys_msg = f"{name} включил(а) «{room.movie['title']}»"
        elif t == "play":
            room.position = position_from(body, room)
            room.playing = True
            room.break_until = None
            room.schedule = None
            if room.session and not room.session["startedAt"]:
                room.session["startedAt"] = time.time() * 1000
            sys_msg = f"{name}: ▶ пуск"
        elif t == "pause":
            room.position = position_from(body, room)
            room.playing = False
            sys_msg = f"{name}: ⏸ пауза"
        elif t == "seek":
            room.position = position_from(body, room)
            sys_msg = None
        elif t == "syncreq":
            # зритель просит администратора прислать своё точное время
            room.broadcast({"type": "syncreq", "name": name})
            return
        elif t == "sync":
            room.position = position_from(body, room)
            room.playing = bool(body.get("playing"))
            sys_msg = f"🔄 Все синхронизированы по {name}"
        elif t == "countdown":
            # общий отсчёт «3-2-1»: ставим на паузу, а запуск пришлёт тот, кто начал отсчёт
            room.position = position_from(body, room)
            room.playing = False
            room.schedule = None  # отсчёт пошёл — расписание выполнено
            room.broadcast({"type": "countdown", "name": name})
            sys_msg = f"{name} запустил(а) обратный отсчёт ⏱"
        elif t == "schedule":
            # 🗓 сеанс по расписанию: время в секундах от «сейчас» — часы у всех разные
            try:
                sec = float(body.get("in"))
            except (TypeError, ValueError):
                sec = 0
            room.schedule = time.time() + sec if 0 < sec < 7 * 86400 else None
            room.position = room.current_position()
            room.playing = False
            sys_msg = f"🗓 {name} назначил(а) сеанс" if room.schedule else f"{name} отменил(а) сеанс"
        elif t == "break":
            # перерыв: пауза у всех и общий таймер
            try:
                minutes = min(30, max(1, round(float(body.get("minutes") or 5))))
            except (TypeError, ValueError):
                minutes = 5
            room.position = position_from(body, room)
            room.playing = False
            room.break_until = time.time() + minutes * 60
            sys_msg = f"☕ {name} объявил(а) перерыв на {minutes} мин"
        elif t == "typing":
            room.broadcast({"type": "typing", "name": name, "client": body.get("client")})
            return
        elif t in ("readycheck", "ready"):
            # «Все готовы?»: сервер только передаёт сигнал, запуск делает тот, кто спросил
            room.broadcast({"type": t, "name": name, "client": body.get("client")})
            return
        elif t == "lag":
            # клиент сообщает, только когда начал или перестал отставать — это редкое событие
            client = room.clients.get(body.get("client"))
            if client:
                try:
                    client["lag"] = min(36000, max(0, round(float(body.get("lag") or 0))))
                except (TypeError, ValueError):
                    client["lag"] = 0
                room.broadcast_users()
            return
        elif t in ("propose", "vote", "unpropose"):
            mid = str(body.get("id", ""))
            if not MOVIE_ID.match(mid):
                return
            p = next((x for x in room.proposals if x["id"] == mid), None)
            if t == "propose" and not p:
                title = str(body.get("title", "")).strip()[:120] or "Фильм"
                room.proposals = (room.proposals + [{"id": mid, "title": title, "by": name, "votes": [name]}])[-8:]
                room.broadcast({"type": "system", "text": f"🗳 {name} предлагает «{title}»"})
            elif t == "propose" and p:
                if name not in p["votes"]:
                    p["votes"].append(name)
            elif t == "vote" and p:
                # голос «за» — повторное нажатие снимает голос
                p["votes"] = [v for v in p["votes"] if v != name] if name in p["votes"] else p["votes"] + [name]
            elif t == "unpropose" and p and (admin or p["by"] == name):
                room.proposals = [x for x in room.proposals if x is not p]
            else:
                return
            room.broadcast(room.extras())
            return
        elif t == "mode":
            if not admin:
                raise Forbidden("Переключать режим может только администратор")
            room.position = room.current_position()  # время ниже обновится — не теряем позицию
            room.everyone = bool(body.get("everyone"))
            sys_msg = ("Администратор разрешил всем управлять просмотром" if room.everyone
                       else "Администратор оставил управление просмотром только себе")
        elif t == "chat":
            text = str(body.get("text", "")).strip()[:500]
            if not text:
                return
            msg = {"type": "chat", "id": secrets.token_hex(4), "name": name, "text": text, "ts": time.time()}
            to = next((m for m in room.chat if body.get("reply") and m.get("id") == body.get("reply")), None)
            if to:  # ответ на сообщение
                msg["reply"] = {"id": to["id"], "name": to["name"], "text": to["text"][:80]}
            if room.session:
                room.session["messages"] += 1
                room.session["talk"][name] = room.session["talk"].get(name, 0) + 1
            room.chat = (room.chat + [msg])[-100:]
            room.broadcast(msg)
            return
        elif t == "react":
            if body.get("emoji") in REACTIONS:
                room.broadcast({"type": "react", "emoji": body["emoji"], "name": name})
                if room.session:
                    room.session["reacts"][body["emoji"]] = room.session["reacts"].get(body["emoji"], 0) + 1
            return
        elif t == "msgreact":
            # реакция на сообщение в чате; повторное нажатие снимает её
            msg = next((m for m in room.chat if m.get("id") and m["id"] == body.get("id")), None)
            emoji = body.get("emoji")
            if not msg or emoji not in MSG_REACTS:
                return
            r = dict(msg.get("reactions") or {})
            who = r.get(emoji, [])
            r[emoji] = [n for n in who if n != name] if name in who else who + [name]
            if not r[emoji]:
                del r[emoji]
            msg["reactions"] = r
            room.broadcast({"type": "msgreact", "id": msg["id"], "reactions": r})
            return
        elif t == "avatar":
            client = room.clients.get(body.get("client"))
            if client:
                client["av"] = valid_avatar(body.get("avatar"))
                room.broadcast_users()
            return
        elif t in ("giveadmin", "kick"):
            if not admin:
                raise Forbidden("Это может только администратор комнаты")
            target = str(body.get("target", ""))[:30]
            if not target or target == name or target not in room.users():
                return
            if t == "giveadmin":
                # корона переходит вместе с новым секретом: у старого админа он больше не действует
                room.admin_key = secrets.token_hex(16)
                for c in room.clients.values():
                    c["admin"] = c["name"] == target
                room.send_to_name(target, {"type": "adminkey", "key": room.admin_key})
                for u in room.users():
                    room.send_to_name(u, {"type": "you", "admin": u == target})
                room.broadcast({"type": "system", "text": f"👑 {name} передал(а) корону: теперь администратор — {target}"})
            else:
                # выгнать: на 10 минут нельзя вернуться ни с этой вкладки, ни под этим именем
                until = time.time() + 600
                room.banned["n:" + target] = until
                for cid, c in list(room.clients.items()):
                    if c["name"] == target:
                        room.banned[cid] = until
                        room.presence.pop(cid, None)
                        c["queue"].put({"type": "kicked"})
                        del room.clients[cid]
                room.broadcast({"type": "system", "text": f"{target} удалён(а) из комнаты"})
                track_usage(room)
            room.broadcast_users()
            return
        elif t == "rate":
            # ⭐ оценка фильма — сохраняется в истории комнаты
            try:
                stars = round(float(body.get("stars")))
            except (TypeError, ValueError):
                return
            h = room.movie and next((x for x in room.history if x["id"] == room.movie["id"]), None)
            if not h or not 1 <= stars <= 5:
                return
            h["ratings"] = {**h.get("ratings", {}), name: stars}
            room.broadcast(room.extras())
            return
        elif t == "summary":
            # «итоги вечера»: отдаём только тому, кто спросил
            ss = room.session if room.session and room.movie and room.session["movieId"] == room.movie["id"] else None
            h = room.movie and next((x for x in room.history if x["id"] == room.movie["id"]), None)
            return {"ok": True, "summary": ss and {**ss, "title": room.movie["title"],
                                                  "position": room.current_position(),
                                                  "ratings": (h or {}).get("ratings", {})}}
        elif t == "rename":
            client = room.clients.get(body.get("client"))
            new = str(body.get("new", "")).strip()[:30]
            if client and new and new != client["name"]:
                old, client["name"] = client["name"], new
                if body.get("client") in room.presence:
                    room.presence[body["client"]]["name"] = new
                room.broadcast({"type": "system", "text": f"{old} теперь {new}"})
                room.broadcast_users()
            return
        else:
            return
        room.updated = room.last_active = time.time()
        st = room.state()
        st["by"] = body.get("client")
        room.broadcast(st)
        if sys_msg:
            room.broadcast({"type": "system", "text": sys_msg})


# «значок на телефоне»: сайт открывается как приложение
MANIFEST = {
    "name": "КиноВместе", "short_name": "КиноВместе", "lang": "ru", "start_url": "/", "scope": "/",
    "display": "standalone", "background_color": "#0b0b10", "theme_color": "#0b0b10",
    "description": "Смотрите фильмы вместе с друзьями",
    "icons": [{"src": "/icon-192.png", "sizes": "192x192", "type": "image/png"},
              {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable"}],
}


# ---------------- Панель администратора сайта ----------------

ADMIN_TTL = 12 * 3600  # вход действует 12 часов


def admin_password():
    return os.environ.get("ADMIN_PASSWORD", "")


def admin_token(exp):
    sig = hmac.new(admin_password().encode(), f"kv-admin:{exp}".encode(), hashlib.sha256).hexdigest()
    return f"{exp}.{sig}"


def admin_session(cookie_header):
    if not admin_password():
        return False
    m = re.search(r"(?:^|;\s*)kv_admin=(\d+)\.([0-9a-f]{64})", cookie_header or "")
    if not m or int(m.group(1)) < time.time():
        return False
    # сравнение за постоянное время: по нему нельзя угадывать подпись побуквенно
    return hmac.compare_digest(admin_token(m.group(1)), f"{m.group(1)}.{m.group(2)}")


# ---------------- HTTP ----------------

class Handler(BaseHTTPRequestHandler):
    server_version = "KinoVmeste/1.0"

    def log_message(self, fmt, *args):
        if "/events" not in str(args[0] if args else ""):
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
            if p in ("/admin", "/admin/"):
                return self.send_file(os.path.join(STATIC, "admin.html"), "text/html; charset=utf-8")
            if p == "/api/admin/status":
                return self.send_json({"enabled": bool(admin_password()),
                                       "authed": admin_session(self.headers.get("Cookie"))})
            if p == "/api/admin/rooms":
                if not admin_password():
                    return self.send_json({"error": "disabled"}, 503)
                if not admin_session(self.headers.get("Cookie")):
                    return self.send_json({"error": "auth"}, 401)
                return self.send_json(rooms_overview())
            if p == "/api/search":
                page = max(1, int(qs.get("page", ["1"])[0]))
                return self.send_json(search_movies(
                    qs.get("q", [""])[0], qs.get("genre", [""])[0], page,
                    qs.get("sort", ["popular"])[0]))
            if p == "/api/rutube/search":
                return self.send_json(rutube_search(qs.get("q", [""])[0], max(1, int(qs.get("page", ["1"])[0] or 1))))
            if p == "/api/wiki":
                return self.send_json(wiki_about(qs.get("title", [""])[0], qs.get("year", [""])[0],
                                                 qs.get("strict", [""])[0] == "1") or {})
            if p == "/api/top":
                week = time.time() * 1000 - 7 * 86400 * 1000
                with rooms_lock:
                    items = sorted(({"id": k, "title": f["title"], "source": f["source"], "n": f["n"]}
                                    for k, f in films.items() if f["last"] > week), key=lambda f: -f["n"])[:12]
                return self.send_json({"items": items})
            if p == "/manifest.webmanifest":
                return self.send_json(MANIFEST)
            if p in ("/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"):
                return self.send_file(os.path.join(STATIC, p[1:]), "image/png")
            if p.startswith("/api/room/") and p.endswith("/info"):
                with rooms_lock:
                    room = rooms.get(p.split("/")[3])
                return self.send_json({"taken": bool(room and (room.admin_key or room.movie or room.chat))})
            if p == "/api/yt/search":
                return self.send_json(youtube_search(qs.get("q", [""])[0], qs.get("page", [""])[0]))
            if p == "/api/link":
                info = info_from_link(qs.get("url", [""])[0].strip())
                if not info:
                    return self.send_json({"error": "Не получилось открыть ссылку: нужна ссылка на видео "
                                                    "YouTube, VK Видео или Rutube"}, 404)
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

    def send_cookie_json(self, obj, cookie):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(data)

    def admin_post(self, p, body):
        if not admin_password():
            return self.send_json({"error": "disabled"}, 503)
        if p == "/api/admin/login":
            given = str(body.get("password", "")).encode()
            if not hmac.compare_digest(hashlib.sha256(given).digest(),
                                       hashlib.sha256(admin_password().encode()).digest()):
                time.sleep(0.6)  # перебор паролей — медленнее
                return self.send_json({"error": "Неверный пароль"}, 401)
            exp = int(time.time()) + ADMIN_TTL
            return self.send_cookie_json({"ok": True}, f"kv_admin={admin_token(exp)}; Path=/; HttpOnly; "
                                                       f"SameSite=Strict; Max-Age={ADMIN_TTL}")
        if p == "/api/admin/room":
            if not admin_session(self.headers.get("Cookie")):
                return self.send_json({"error": "auth"}, 401)
            rid, action = str(body.get("id", "")), body.get("action")
            if not re.match(r"^[\w-]{1,64}$", rid) or action not in ("announce", "close"):
                return self.send_json({"error": "bad request"}, 400)
            if action == "announce" and not str(body.get("text", "")).strip():
                return self.send_json({"error": "Пустое сообщение"}, 400)
            return self.send_json(site_admin(rid, action, body.get("text")))
        if p == "/api/admin/logout":
            return self.send_cookie_json({"ok": True}, "kv_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0")
        self.send_error(404)

    def do_POST(self):
        p = urllib.parse.urlparse(self.path).path
        if p.startswith("/api/admin/"):
            length = int(self.headers.get("Content-Length", 0))
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                body = {}
            return self.admin_post(p, body if isinstance(body, dict) else {})
        if p.startswith("/api/room/") and p.endswith("/action"):
            length = int(self.headers.get("Content-Length", 0))
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                return self.send_json({"error": "bad json"}, 400)
            try:
                res = room_action(get_room(p.split("/")[3]), body)
            except Forbidden as e:
                return self.send_json({"error": str(e), "forbidden": True}, 403)
            except Exception as e:  # noqa: BLE001
                return self.send_json({"error": str(e)}, 502)
            return self.send_json(res or {"ok": True})
        self.send_error(404)

    def sse(self, rid, qs):
        room = get_room(rid)
        cid = qs.get("client", [secrets.token_hex(4)])[0][:40]
        name = qs.get("name", ["Гость"])[0][:30]
        key = qs.get("admin", [""])[0][:64]
        q = queue.Queue()
        with room.lock:
            banned = room.is_banned(cid, name)
        if banned:  # выгнанный админом не возвращается сразу
            data = b"data: " + json.dumps({"type": "kicked"}).encode() + b"\n\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            return self.wfile.write(data)
        with room.lock:
            if key and room.admin_key is None:
                room.admin_key = key  # первым с секретом приходит создатель комнаты
            back = join_room(room, cid, name)
            room.clients[cid] = {"name": name, "queue": q, "admin": room.is_admin(key),
                                 "av": valid_avatar(qs.get("avatar", [""])[0])}
            q.put({"type": "you", "admin": room.is_admin(key)})
            q.put(room.state())
            q.put(room.extras())
            for m in room.chat[-30:]:
                q.put(m)
            if not back:
                room.broadcast({"type": "system", "text": f"{name} зашёл(а) в комнату"})
            room.broadcast_users()
            track_usage(room)

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
                del room.clients[cid]
                # «вышел» напишем позже, если человек не вернётся за LEAVE_GRACE
                now = time.time()
                room.presence[cid] = {"name": me["name"], "left_at": now}
                room.last_active = now
                if not room.clients:
                    room.empty_since = now
                room.broadcast_users()
                track_usage(room)
            timer = threading.Timer(LEAVE_GRACE, finish_leave, (room, cid))
            timer.daemon = True
            timer.start()


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
