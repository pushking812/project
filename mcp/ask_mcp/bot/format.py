"""Форматирование ответов: разбиение на сообщения, обрезка, читаемый JSON.

Telegram принимает 4096 символов в сообщении, поэтому по умолчанию режем на куски по 3900.
Разметка не используется: текст инструментов — обычный, экранировать его не нужно.
"""

import json

DEFAULT_LIMIT = 3900
FENCE = "```"


def split_text(text: str, limit: int = DEFAULT_LIMIT) -> list[str]:
    """Разбить длинный текст на куски не больше limit, по возможности по строкам.

    Если кусок начинается внутри блока ``` (например, ответ модели с кодом), блок закрывается
    в конце куска и открывается снова в начале следующего — иначе Telegram покажет «сырые» ```.
    """
    text = (text or "").strip()
    if not text:
        return [""]
    limit = max(100, int(limit))
    if len(text) <= limit:
        return [text]

    chunks: list[str] = []
    rest = text
    while len(rest) > limit:
        cut = rest.rfind("\n", 0, limit)
        if cut < limit // 2:
            cut = limit
        chunk = rest[:cut].rstrip("\n")
        rest = rest[cut:].lstrip("\n")
        if chunk:
            chunks.append(chunk)
    if rest:
        chunks.append(rest)
    return _close_fences(chunks)


def _close_fences(chunks: list[str]) -> list[str]:
    out: list[str] = []
    carry = ""
    for chunk in chunks:
        if carry:
            chunk = carry + chunk
        if chunk.count(FENCE) % 2:
            chunk = chunk.rstrip("\n") + "\n" + FENCE
            carry = FENCE + "\n"
        else:
            carry = ""
        out.append(chunk)
    return out


def clip(text: str, limit: int = DEFAULT_LIMIT) -> str:
    """Обрезать текст с пометкой, сколько было всего."""
    text = text or ""
    if len(text) <= limit:
        return text
    head = text[: max(0, limit - 60)].rstrip()
    return f"{head}\n… (обрезано, всего {len(text)} символов)"


def payload(raw: str) -> dict:
    """JSON-текст инструмента -> dict. Не JSON — {"text": <как есть>}."""
    raw = raw or ""
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return {"text": raw}
    return data if isinstance(data, dict) else {"value": data}


def text_of(data: dict) -> str:
    """Главный текст ответа: text, answer, summary или output."""
    for key in ("text", "answer", "summary", "output"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return ""


def pretty(raw: str, limit: int | None = None) -> str:
    """JSON с отступом 2 (читаемо в чате). Не JSON — как есть."""
    raw = (raw or "").strip()
    if not raw:
        return "(пусто)"
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return clip(raw, limit) if limit else raw
    out = json.dumps(data, ensure_ascii=False, indent=2)
    return clip(out, limit) if limit else out


def usage_line(usage) -> str:
    """Короткая строка про расход: usage: input=1, output=2."""
    if not isinstance(usage, dict) or not usage:
        return ""
    parts = [f"{k}={v}" for k, v in usage.items() if isinstance(v, (int, float, str)) and v != ""]
    return "usage: " + ", ".join(parts) if parts else ""


def files_line(files) -> str:
    """Строка со списком созданных файлов (пути относительные)."""
    if not isinstance(files, list) or not files:
        return ""
    shown = ", ".join(str(f) for f in files[:20])
    more = f" и ещё {len(files) - 20}" if len(files) > 20 else ""
    return f"Файлы: {shown}{more}"


def seconds(value: float) -> str:
    """Длительность для человека: 12 c, 2 м 05 c, 1 ч 03 м."""
    value = max(0, int(value))
    if value < 60:
        return f"{value} c"
    minutes, sec = divmod(value, 60)
    if minutes < 60:
        return f"{minutes} м {sec:02d} c"
    hours, minutes = divmod(minutes, 60)
    return f"{hours} ч {minutes:02d} м"
