"""Перехватчик обмена оригинального клиента ask-code с сайтом (только для разбора формата).

Как пользоваться (PowerShell, из папки project):
    cd mcp
    python code_tap.py                      # слушает http://127.0.0.1:8790, пересылает на https://ask.oryxml.com
    # в другом окне, в нужной папке:
    $env:ASK_SITE = 'http://127.0.0.1:8790'; $env:ASK_KEY = '<ключ>'; $env:ASK_NO_UPDATE = '1'
    node C:\\...\\project\\vendor\\ask-code.mjs

Каждый запрос, ответ и каждое SSE-событие дописываются в project/tap/<дата-время>.jsonl, по строке JSON.
Ключи (Authorization, sk-ask-…) в файл не попадают. Длинные строки (содержимое файлов) режутся до 2000 знаков,
TAP_FULL=1 оставляет их целиком. Файлы содержат содержимое вашей папки: в git их не кладите (папка tap/ в .gitignore).

Переменные: TAP_SITE (куда пересылать), TAP_PORT (по умолчанию 8790), TAP_DIR (куда писать), TAP_FULL.
"""

import json
import os
import re
import sys
import time
from datetime import datetime

import httpx
import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import Response, StreamingResponse
from starlette.routing import Route

SITE = (os.environ.get("TAP_SITE", "").strip() or "https://ask.oryxml.com").rstrip("/")
HOST = "127.0.0.1"
PORT = int(os.environ.get("TAP_PORT", "").strip() or 8790)
FULL = os.environ.get("TAP_FULL", "").strip() in ("1", "true", "yes")
STR_LIMIT = 2000
OUT_DIR = os.environ.get("TAP_DIR", "").strip() or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tap")
LOG_PATH = os.path.join(OUT_DIR, datetime.now().strftime("%Y%m%d-%H%M%S") + ".jsonl")

_KEY_RE = re.compile(r"sk-ask-[A-Za-z0-9_\-]{6,}")
_SECRET_HEADERS = {"authorization", "cookie", "set-cookie", "x-api-key"}
_SKIP_REQ = {"host", "content-length", "connection", "accept-encoding"}
_SKIP_RES = {"content-length", "transfer-encoding", "content-encoding", "connection"}
_t0 = time.monotonic()
_counter = 0


def _clean(value, key: str = ""):
    """Копия значения без ключей; длинные строки режутся (если не TAP_FULL)."""
    if isinstance(value, str):
        if key.lower() in ("key", "token", "secret"):
            return "[скрыто]"
        value = _KEY_RE.sub("sk-ask-[скрыто]", value)
        if not FULL and len(value) > STR_LIMIT:
            return value[:STR_LIMIT] + f"…[ещё {len(value) - STR_LIMIT} знаков, всего {len(value)}]"
        return value
    if isinstance(value, dict):
        return {k: _clean(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [_clean(v) for v in value]
    return value


def _headers(h) -> dict:
    return {k: ("[скрыто]" if k.lower() in _SECRET_HEADERS else _KEY_RE.sub("sk-ask-[скрыто]", v))
            for k, v in h.items()}


def _write(rec: dict) -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    rec = {"t": round(time.monotonic() - _t0, 3), **rec}
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def _body(raw: bytes, content_type: str):
    if not raw:
        return None
    text = raw.decode("utf-8", "replace")
    if "json" in content_type:
        try:
            return _clean(json.loads(text))
        except ValueError:
            pass
    return _clean(text)


def _parse_event(block: str) -> dict | None:
    event, data = "message", []
    for line in block.split("\n"):
        if line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data.append(line[5:].lstrip())
    if not data:
        return None
    raw = "\n".join(data)
    try:
        return {"event": event, "data": _clean(json.loads(raw))}
    except ValueError:
        return {"event": event, "data": _clean(raw)}


async def tap(request: Request):
    raw = await request.body()
    ctype = request.headers.get("content-type", "")
    global _counter
    _counter += 1
    rid = _counter
    path = request.url.path + (f"?{request.url.query}" if request.url.query else "")
    _write({"id": rid, "dir": "req", "method": request.method, "path": path,
            "headers": _headers(request.headers), "body": _body(raw, ctype)})
    headers = {k: v for k, v in request.headers.items() if k.lower() not in _SKIP_REQ}
    headers["accept-encoding"] = "identity"
    client = httpx.AsyncClient(base_url=SITE, timeout=httpx.Timeout(connect=15.0, read=900.0, write=60.0, pool=15.0))
    upstream_req = client.build_request(request.method, path, headers=headers, content=raw or None)
    try:
        up = await client.send(upstream_req, stream=True)
    except httpx.HTTPError as e:
        await client.aclose()
        _write({"id": rid, "dir": "res", "status": 502, "error": f"{type(e).__name__}: {e}"})
        return Response(f"tap: не достучался до {SITE}: {e}", status_code=502)
    out_headers = {k: v for k, v in up.headers.items() if k.lower() not in _SKIP_RES}
    is_sse = "text/event-stream" in up.headers.get("content-type", "")
    _write({"id": rid, "dir": "res", "status": up.status_code, "headers": _headers(up.headers), "sse": is_sse})

    if not is_sse:
        data = await up.aread()
        await up.aclose()
        await client.aclose()
        _write({"id": rid, "dir": "res-body", "body": _body(data, up.headers.get("content-type", ""))})
        return Response(data, status_code=up.status_code, headers=out_headers)

    async def pump():
        buf = ""
        try:
            async for chunk in up.aiter_bytes():
                yield chunk
                buf += chunk.decode("utf-8", "replace").replace("\r\n", "\n")
                while "\n\n" in buf:
                    block, buf = buf.split("\n\n", 1)
                    ev = _parse_event(block)
                    if ev:
                        _write({"id": rid, "dir": "event", **ev})
            if buf.strip():
                ev = _parse_event(buf)
                if ev:
                    _write({"id": rid, "dir": "event", **ev})
            _write({"id": rid, "dir": "end", "note": "поток закрыт сайтом"})
        except BaseException as e:  # клиент ушёл (Ctrl+C) или сеть оборвалась
            _write({"id": rid, "dir": "end", "note": f"поток прерван: {type(e).__name__}"})
            raise
        finally:
            await up.aclose()
            await client.aclose()

    return StreamingResponse(pump(), status_code=up.status_code, headers=out_headers,
                             media_type=up.headers.get("content-type"))


app = Starlette(routes=[Route("/{path:path}", tap, methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])])


if __name__ == "__main__":
    print(f"tap http://{HOST}:{PORT} -> {SITE}\nзапись: {LOG_PATH}\n"
          f"{'строки целиком' if FULL else f'строки длиннее {STR_LIMIT} режутся'}; ключи скрыты", file=sys.stderr)
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
