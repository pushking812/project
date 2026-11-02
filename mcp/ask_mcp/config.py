"""Настройки: .env рядом с server.py, переменные окружения, флаги запуска."""

import argparse
import os
import sys
from urllib.parse import urlparse

import httpx

LOCAL_HOSTS = ("127.0.0.1", "::1", "localhost")
BACKENDS = ("api", "legacy", "both")
DEFAULT_LOCAL_URL = "http://127.0.0.1:8737"


def load_dotenv() -> None:
    """Читает .env рядом с server.py (KEY=VALUE). Уже заданные переменные не трогает."""
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(root, ".env")
    try:
        with open(path, encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k, v = k.strip(), v.strip().strip('"').strip("'")
                if k and v and not os.environ.get(k):
                    os.environ[k] = v
    except OSError:
        pass


load_dotenv()

# Сайт Ask: нужен только прежним инструментам (бэкенд legacy) и OpenAI-прокси.
BASE_URL = os.environ.get("ASK_BASE_URL", "https://ask.oryxml.com").rstrip("/")
TIMEOUT = httpx.Timeout(connect=15.0, read=300.0, write=60.0, pool=15.0)


def backend() -> str:
    """MCP_BACKEND: api (по умолчанию) | legacy | both. Неизвестное значение — сообщение и код 2."""
    value = (os.environ.get("MCP_BACKEND") or "api").strip().lower()
    if value not in BACKENDS:
        print(f"MCP_BACKEND должен быть одним из {', '.join(BACKENDS)}, получено: {value!r}", file=sys.stderr)
        raise SystemExit(2)
    return value


def local_api_url() -> str:
    """Адрес нашего HTTP API (ASK_LOCAL_URL). У него нет аутентификации, поэтому только петля,
    если не задано ASK_ALLOW_REMOTE. Читается при каждом вызове: тесты и смена порта без перезапуска."""
    raw = (os.environ.get("ASK_LOCAL_URL") or DEFAULT_LOCAL_URL).strip().rstrip("/")
    parsed = urlparse(raw)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError(f"ASK_LOCAL_URL должен быть адресом вида http://127.0.0.1:8737, получено: {raw!r}")
    allow = os.environ.get("ASK_ALLOW_REMOTE", "").strip().lower() in ("1", "true", "yes")
    if parsed.hostname not in LOCAL_HOSTS and not allow:
        raise ValueError(
            f"ASK_LOCAL_URL={raw} указывает не на этот компьютер, а у API нет аутентификации. "
            "Оставьте 127.0.0.1 или задайте ASK_ALLOW_REMOTE=1 осознанно."
        )
    return raw


def cli(argv: list[str]) -> argparse.Namespace:
    """Разбор флагов запуска: неизвестный аргумент — сообщение и код 2, --help — справка."""
    p = argparse.ArgumentParser(prog="server.py", description="MCP-сервер Ask API (по умолчанию stdio).")
    p.add_argument("--http", action="store_true", help="постоянный HTTP-сервер вместо stdio")
    p.add_argument("--host", help="адрес (по умолчанию ASK_HOST или 127.0.0.1)")
    p.add_argument("--port", type=int, help="порт (по умолчанию ASK_PORT или 8000)")
    args = p.parse_args(argv)
    if not args.http and (args.host or args.port is not None):
        p.error("--host и --port работают только вместе с --http")
    return args


def bind_settings(host: str | None = None, port: int | None = None) -> tuple[str, int]:
    """ASK_HOST/ASK_PORT (или --host/--port) -> (host, port). Внешний bind без ASK_ALLOW_REMOTE запрещён."""
    host = host or os.environ.get("ASK_HOST") or "127.0.0.1"
    if port is None:
        raw_port = os.environ.get("ASK_PORT") or "8000"
        try:
            port = int(raw_port)
        except ValueError:
            print(f"ASK_PORT должен быть числом, получено: {raw_port!r}", file=sys.stderr)
            raise SystemExit(2)
    if not 1 <= port <= 65535:
        print(f"Порт должен быть в диапазоне 1..65535, получено: {port}", file=sys.stderr)
        raise SystemExit(2)
    allow = os.environ.get("ASK_ALLOW_REMOTE", "").strip().lower() in ("1", "true", "yes")
    if host not in LOCAL_HOSTS and not allow:
        print(
            f"ASK_HOST={host} открыл бы сервер всей сети: любой в ней потратит ваш лимит.\n"
            "Оставьте 127.0.0.1 или задайте ASK_ALLOW_REMOTE=1 осознанно.",
            file=sys.stderr,
        )
        raise SystemExit(2)
    return host, port
