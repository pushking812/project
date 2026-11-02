"""Браузер: POST /browser (одно окно на сервер), GET /browser, POST /browser/handoff/done.

Каждое действие — отдельный инструмент browser_*. Снимки страницы возвращаются как картинки MCP.
Капчу проходит только человек: browser_handoff передаёт ему окно, browser_handoff_done сообщает, что он закончил.
"""

import base64
from typing import Literal

from mcp.server.fastmcp import Image

from ..api_client import ApiResult, call, dumps
from ..errors import AskError

Mode = Literal["all", "edits", "plan"]
Captcha = Literal["manual", "handoff"]


def _images(items) -> list[Image]:
    out = []
    for item in items or []:
        try:
            fmt = str(item.get("mediaType", "image/jpeg")).split("/")[-1] or "jpeg"
            out.append(Image(data=base64.b64decode(item["data"]), format=fmt))
        except (KeyError, ValueError, TypeError, AttributeError):
            continue  # битый снимок не должен ронять весь ответ
    return out


def _render(res: ApiResult):
    """JSON без base64-картинок (они идут отдельными блоками). Поток SSE (handoff) сворачивается в список событий."""
    images: list[Image] = []
    if res.is_stream:
        events = []
        for event, data in res.events or []:
            if event == "error":
                raise AskError(str(data.get("message") or data))
            images += _images(data.get("images"))
            events.append({"event": event, **{k: v for k, v in data.items() if k != "images"}})
        text = dumps({"events": events})
    else:
        data = dict(res.data)
        images = _images(data.pop("images", None))
        text = dumps(data)
    return [text, *images] if images else text


async def _act(action: str, read_timeout: float = 60.0, **fields):
    """POST /browser {action, ...}. Шаг дольше 30 с сервер обрывает сам (504)."""
    res = await call("POST", "/browser", {"action": action, **fields}, read_timeout=read_timeout)
    return _render(res)


async def browser_open(
    url: str,
    mode: Mode | None = None,
    allowed_sites: list[str] | None = None,
    headless: bool | None = None,
    captcha: Captcha | None = None,
):
    """Открыть страницу (action open). Первый вызов запускает окно браузера.

    url: адрес; example.com дополняется до https://, localhost и 127.0.0.1 — до http://.
    mode: all — любые сайты; edits и plan — только localhost, файлы проекта и хосты из allowed_sites.
    headless: false — видимое окно (на той же странице), true — снова скрыть. Выбор действует дальше.
    captcha: handoff — если капча мешает, сервер сам покажет окно и позовёт человека (ответ придёт после его действий).
    Возвращает output, снимок страницы, captcha и handoff_needed.
    """
    return await _act("open", url=url, mode=mode, allowedSites=allowed_sites, headless=headless, captcha=captcha,
                      read_timeout=600.0 if captcha == "handoff" else 60.0)


async def browser_read(headless: bool | None = None, captcha: Captcha | None = None):
    """Прочитать страницу текстом (action read): адрес, заголовок, видимый текст, ссылки, поля и кнопки.

    Дешевле снимка. Оттуда берут значения для selector в browser_click и browser_type.
    Если на странице капча, в ответе появится captcha и handoff_needed.
    """
    return await _act("read", headless=headless, captcha=captcha,
                      read_timeout=600.0 if captcha == "handoff" else 60.0)


async def browser_screenshot():
    """Снимок страницы (action screenshot) как картинка. Нужен, чтобы увидеть вёрстку или найти координаты для клика."""
    return await _act("screenshot")


async def browser_click(
    selector: str | None = None,
    x: int | None = None,
    y: int | None = None,
    mode: Mode | None = None,
    allowed_sites: list[str] | None = None,
):
    """Нажать (action click): selector — CSS (#buy) или text=Слова на элементе; либо координаты x и y со снимка.

    Нет элемента — 404. Клик, уводящий на сайт вне allowed_sites (при mode не all), откатывается и даёт 403.
    """
    return await _act("click", selector=selector, x=x, y=y, mode=mode, allowedSites=allowed_sites)


async def browser_type(text: str, selector: str | None = None):
    """Ввести текст (action type) в поле selector или туда, где стоит курсор.

    Поля пароля и карты сервер не заполняет (403 private): такой шаг делает человек через browser_handoff.
    """
    return await _act("type", text=text, selector=selector)


async def browser_press(key: str = "Enter", mode: Mode | None = None, allowed_sites: list[str] | None = None):
    """Нажать клавишу (action press): Enter, Escape, Tab, одна буква."""
    return await _act("press", key=key, mode=mode, allowedSites=allowed_sites)


async def browser_scroll(dy: int | None = None):
    """Прокрутить (action scroll). dy в пикселях: положительное вниз, отрицательное вверх; по умолчанию 80% высоты окна."""
    return await _act("scroll", dy=dy)


async def browser_console():
    """Ошибки и предупреждения консоли страницы с прошлого вызова (action console). Прочитанное удаляется."""
    return await _act("console")


async def browser_back(mode: Mode | None = None, allowed_sites: list[str] | None = None):
    """Вернуться на прошлую страницу (action back)."""
    return await _act("back", mode=mode, allowedSites=allowed_sites)


async def browser_viewport(width: int | None = None, height: int | None = None):
    """Размер окна (action viewport): width меньше 700 включает режим телефона. Без width — вернуть как было."""
    return await _act("viewport", width=width, height=height)


async def browser_close():
    """Закрыть окно браузера (action close). Входы в аккаунты сохраняются в профиле. Следующий open запустит окно заново."""
    return await _act("close")


async def browser_state() -> str:
    """Состояние окна без действия (GET /browser): running, headless, url, handoff (ждёт ли человека)."""
    res = await call("GET", "/browser")
    return dumps(res.data)


async def browser_handoff(text: str | None = None, headless: bool | None = None):
    """Передать окно человеку (action handoff) и ждать, пока он закончит.

    Нужна для капчи, входа в аккаунт, пароля, кода из SMS, окна согласия: то, что должен сделать живой человек.
    text: что сделать (человек видит это в уведомлении). headless: false показывает невидимое окно на той же странице.
    Вызов не возвращается до конца передачи (до 8 минут): капча решена (how=done), человек сообщил browser_handoff_done
    (how=said), таймаут или закрытие окна. Пока идёт передача, остальные действия отвечают 409.
    """
    return await _act("handoff", text=text, headless=headless, read_timeout=600.0)


async def browser_handoff_done(note: str | None = None) -> str:
    """Сообщить, что человек закончил передачу (POST /browser/handoff/done). Без активной передачи будет 409 no_handoff."""
    res = await call("POST", "/browser/handoff/done", {"note": note})
    return dumps(res.data)


TOOLS = [
    browser_open, browser_read, browser_screenshot, browser_click, browser_type, browser_press, browser_scroll,
    browser_console, browser_back, browser_viewport, browser_close, browser_state, browser_handoff,
    browser_handoff_done,
]
