"""Разбор SSE (Server-Sent Events) из ответа httpx. Один разбор на оба бэкенда."""

import json

import httpx


def parse_event(event: str, data: list[str]) -> tuple[str, dict] | None:
    if not data:
        return None
    try:
        payload = json.loads("\n".join(data))
    except json.JSONDecodeError:
        return None
    # payload бывает числом, строкой или null — вызывающий читает его через .get().
    return (event, payload) if isinstance(payload, dict) else None


async def sse_frames(response: httpx.Response):
    """Разбирает SSE: отдаёт тройки (event, data_json, event_id).

    event_id «залипает»: блок без id: наследует предыдущий; не было ни одного — None.
    """
    event, data, event_id = "message", [], None
    async for line in response.aiter_lines():
        if line == "":
            parsed = parse_event(event, data)
            if parsed:
                yield parsed[0], parsed[1], event_id
            event, data = "message", []
        elif line.startswith(":"):
            continue  # heartbeat
        elif line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data.append(line[5:].lstrip())
        elif line.startswith("id:"):
            event_id = line[3:].strip()
    # Поток мог закрыться без завершающей пустой строки: не теряем последнее событие.
    parsed = parse_event(event, data)
    if parsed:
        yield parsed[0], parsed[1], event_id


async def sse_events(response: httpx.Response):
    """Разбирает SSE: отдаёт пары (event, data_json)."""
    async for event, data, _ in sse_frames(response):
        yield event, data
