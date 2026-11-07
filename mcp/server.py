"""MCP-сервер Ask: тонкая точка входа. Вся работа — в пакете ask_mcp/.

Бэкенд инструментов (переменная MCP_BACKEND):
  api     (по умолчанию) инструменты вызывают HTTP API нашего сервера ask-code-server (ASK_LOCAL_URL,
          по умолчанию http://127.0.0.1:8737): задачи, файлы, память, сессии, браузер, наблюдения, диагностика.
          Ключ сайта Ask этому процессу не нужен: он у ask-code-server (ASK_KEY).
  legacy  прежние инструменты ask, get_usage, code: прямые вызовы сайта Ask. Нужен ASK_API_KEY (sk-ask-...),
          необязательно ASK_BASE_URL (по умолчанию https://ask.oryxml.com).
  both    новые инструменты и прежние под именами legacy_ask, legacy_get_usage, legacy_code.

Запуск: `python server.py` (stdio) или `python server.py --http` (http://127.0.0.1:8000/mcp, ASK_HOST/ASK_PORT).

Имена ниже (_bind_settings, _ask_stream, ask, code и т. д.) оставлены для openai_proxy.py и тестов: это ссылки
на модули пакета, а не копии. Подмена настроек в тестах делается в самих модулях (например ask_mcp.legacy.code.CODE_ROOT).
"""

import asyncio  # noqa: F401  (тесты подменяют server.asyncio.sleep)
import sys

from mcp.server.fastmcp import FastMCP

from ask_mcp import config as _config
from ask_mcp import legacy as _legacy
from ask_mcp import tools as _tools
from ask_mcp.config import BASE_URL, TIMEOUT  # noqa: F401
from ask_mcp.errors import AskError, StreamError as _StreamError  # noqa: F401
from ask_mcp.legacy.code import (  # noqa: F401
    CODE_DENY,
    CODE_MAX_OUTPUT,
    CODE_ROOT,
    _code_clip,
    _code_denied,
    _code_path,
    _code_rel,
    _code_root,
    _code_run_tool,
    code,
)
from ask_mcp.legacy.remote import (  # noqa: F401
    AskResult,
    State as _State,
    ask,
    ask_stream as _ask_stream,
    check_history as _check_history,
    get_usage,
    handle as _handle,
    headers as _headers,
    http_error_text as _http_error_text,
    http_failure as _http_failure,
    resume as _resume,
)
from ask_mcp.sse import sse_events as _sse_events, sse_frames as _sse_frames  # noqa: F401

_cli = _config.cli
_bind_settings = _config.bind_settings
_load_dotenv = _config.load_dotenv

# Адрес и порт известны до конструктора: защита от DNS-rebinding строится по ним.
# Разбор нужен только для --http; в stdio и в тестах переменные ASK_HOST/ASK_PORT не читаются.
# Строго разбираем argv только при запуске как скрипта; при импорте (тесты, python -c)
# argv чужой, там распознаётся лишь --http.
_ARGS = _cli(sys.argv[1:]) if __name__ == "__main__" else _cli(["--http"] if "--http" in sys.argv else [])
_HOST, _PORT = _bind_settings(_ARGS.host, _ARGS.port) if _ARGS.http else ("127.0.0.1", 8000)

import os  # noqa: E402

# Разделение каталога на несколько серверов (необязательно): MCP_NAME — имя сервера (по умолчанию ask),
# MCP_GROUPS — только эти группы (office,vba), MCP_SKIP_GROUPS — все, кроме этих. Группы: ask_mcp/tools/__init__.py.
mcp = FastMCP(os.environ.get("MCP_NAME", "").strip() or "ask", host=_HOST, port=_PORT)


def register_tools(server: FastMCP, backend: str) -> None:
    """Подключает инструменты выбранного бэкенда."""
    if backend in ("api", "both"):
        try:
            _tools.register(server, _tools.parse_groups(os.environ.get("MCP_GROUPS")),
                            _tools.parse_groups(os.environ.get("MCP_SKIP_GROUPS")))
        except ValueError as e:
            print(e, file=sys.stderr)
            raise SystemExit(2)
    if backend == "legacy":
        _legacy.register(server)
    elif backend == "both":
        _legacy.register(server, prefix="legacy_")


BACKEND = _config.backend()
register_tools(mcp, BACKEND)


if __name__ == "__main__":
    # stdout занят протоколом MCP: логи только в stderr.
    # По умолчанию stdio (для Claude Desktop/Code). Аргумент --http запускает
    # постоянный HTTP-сервер: http://127.0.0.1:8000/mcp (ASK_HOST, ASK_PORT).
    if BACKEND == "legacy":
        where = f"base url: {BASE_URL}"
    else:
        try:
            where = f"api: {_config.local_api_url()}"
        except ValueError as e:
            print(e, file=sys.stderr)
            raise SystemExit(2)
    if _ARGS.http:
        _only = (os.environ.get("MCP_GROUPS") or "").strip()
        _skip = (os.environ.get("MCP_SKIP_GROUPS") or "").strip()
        _groups = f", groups: {_only}" if _only else (f", without: {_skip}" if _skip else ", all groups")
        print(f"{mcp.name} MCP server (http) http://{mcp.settings.host}:{mcp.settings.port}/mcp, "
              f"backend {BACKEND}, {where}{_groups}", file=sys.stderr)
        mcp.run(transport="streamable-http")
    else:
        print(f"ask MCP server (stdio), backend {BACKEND}, {where}", file=sys.stderr)
        mcp.run()
