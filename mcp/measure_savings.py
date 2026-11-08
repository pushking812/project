"""Экономия каталога инструментов в прокси: ужатие схем (PROXY_SLIM_SCHEMA) и исключение серверов (PROXY_TOOL_EXCLUDE).

Запуск из project/mcp:  python measure_savings.py
Ничего не отправляет и не тратит лимит.

1. Ужатие схем: берутся настоящие схемы наших MCP-инструментов (группы main и office), каталог строится
   прокси-функцией _tools_catalog с ужатием и без. Схем родных инструментов Cline здесь нет (прокси
   сохраняет в tools-seen.txt только размеры), поэтому цифра касается только наших 69 инструментов.
2. Исключение: размеры из tools-seen.txt (то, что Cline прислал в последний раз): имя + описание
   (до 400 знаков) + схема, до ужатия.
Знаки делим на 4 для грубой оценки токенов (для русского текста и JSON это приблизительно).
"""

import asyncio
import os
import re
import sys

os.environ.setdefault("PROXY_TOOLS_DUMP", "off")  # не перезаписывать tools-seen.txt

from mcp.server.fastmcp import FastMCP

import openai_proxy as p
from ask_mcp import tools

PREFIX = {"main": "ask__", "office": "ask-extra__"}


def _our_tools() -> list[dict]:
    out = []
    for group, mod in tools.GROUPS.items():
        server = FastMCP("measure")
        for fn in mod.TOOLS:
            server.tool(name=fn.__name__)(fn)
        for t in asyncio.run(server.list_tools()):
            out.append({"type": "function", "function": {
                "name": PREFIX.get(group, f"{group}__") + t.name,
                "description": t.description or "",
                "parameters": t.inputSchema}})
    return out


def _catalog_size(defs: list[dict], slim: bool) -> tuple[int, int]:
    os.environ["PROXY_SLIM_SCHEMA"] = "on" if slim else "off"
    os.environ["PROXY_TOOL_EXCLUDE"] = "craft"  # исключений здесь нет: меряем одно ужатие
    text, count, _ = p._tools_catalog(defs)
    return len(text), count


def _seen(path: str):
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            m = re.match(r"\s*(\d+)\s+(\S+)(\s+\[исключён\])?", line)
            if m:
                rows.append((int(m.group(1)), m.group(2), bool(m.group(3))))
    return rows


def _row(label: str, before: int, after: int) -> None:
    saved = before - after
    pct = 100 * saved / before if before else 0
    print(f"{label:34} {before:7} -> {after:7}  экономия {saved:6} знаков (~{saved // 4} ток., {pct:.1f}%)")


def main() -> None:
    defs = _our_tools()
    print(f"1. Ужатие схем, наши MCP-инструменты ({len(defs)} шт.)")
    raw, n1 = _catalog_size(defs, slim=False)
    slim, n2 = _catalog_size(defs, slim=True)
    _row("каталог без ужатия -> с ужатием", raw, slim)
    if n1 != n2:
        print(f"   ВНИМАНИЕ: число инструментов в каталоге разное: {n1} и {n2}")

    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools-seen.txt")
    rows = _seen(path)
    if not rows:
        print("\n2. tools-seen.txt пуст или не найден:", path)
        return
    total = sum(r[0] for r in rows)
    kept = sum(r[0] for r in rows if not r[2])
    comp = [r for r in rows if r[1].startswith("composio_") and r[2]]
    team = [r for r in rows if r[1].startswith("team_") and r[2]]
    print(f"\n2. Исключение по tools-seen.txt ({len(rows)} инструментов от клиента)")
    _row("всё -> без исключённых", total, kept)
    _row(f"  composio_ ({len(comp)} шт.)", sum(r[0] for r in comp), 0)
    _row(f"  team_ ({len(team)} шт.)", sum(r[0] for r in team), 0)
    print("\nКаталог уходит в каждый запрос в режиме ask; в режиме code (/v1/code) его нет (tools_sent 0).")


if __name__ == "__main__":
    main()
