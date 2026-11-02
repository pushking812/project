"""Прежние инструменты (ask, get_usage, code): прямые вызовы сайта Ask, без нашего HTTP API.

Не удалены: нужны openai_proxy.py и режиму MCP_BACKEND=legacy|both, и их можно дорабатывать дальше.
Здесь же регистрация в MCP.
"""

from . import code as code_module
from . import remote


def register(mcp, prefix: str = "") -> None:
    """Подключает ask, get_usage и code. prefix="legacy_" нужен, когда рядом работают новые инструменты."""
    mcp.tool(name=f"{prefix}ask", structured_output=True)(remote.ask)
    mcp.tool(name=f"{prefix}get_usage")(remote.get_usage)
    mcp.tool(name=f"{prefix}code")(code_module.code)
