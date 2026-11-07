"""Размер каталога инструментов MCP: описание + inputSchema по группам и самые тяжёлые инструменты.

Запуск из project/mcp:  python measure_tools.py [сколько_тяжёлых]
Нужен, чтобы видеть, сколько знаков каталога уходит в промпт Cline (лимит прокси PROXY_TOOLS_BLOCK).
"""

import asyncio
import json
import sys

from mcp.server.fastmcp import FastMCP

from ask_mcp import tools


def _size(t) -> int:
    schema = json.dumps(t.inputSchema, ensure_ascii=False, separators=(",", ":"))
    return len(t.description or "") + len(schema)


def main(top: int) -> None:
    total, count, every = 0, 0, []
    for name, mod in tools.GROUPS.items():
        server = FastMCP("measure")
        for fn in mod.TOOLS:
            server.tool(name=fn.__name__)(fn)
        listed = asyncio.run(server.list_tools())
        size = sum(_size(t) for t in listed)
        total += size
        count += len(listed)
        every += [(_size(t), t.name) for t in listed]
        print(f"{name:10} инструментов {len(listed):3}  знаков {size:6}")
    print(f"{'всего':10} инструментов {count:3}  знаков {total:6}")
    print("самые тяжёлые:")
    for size, name in sorted(every, reverse=True)[:top]:
        print(f"  {name:22} {size}")


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 10)
