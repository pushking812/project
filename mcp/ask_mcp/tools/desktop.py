"""Рабочий стол: скриншоты экрана, монитора, области, активного окна и окна по заголовку, список окон и мониторов.

Работает локально, без HTTP API. Окна и мониторы — только Windows (через ctypes, без лишних библиотек);
скриншот всего экрана и области работает ещё и на macOS (Pillow ImageGrab). Pillow подключается при вызове:
без него сервер стартует, а инструмент вернёт понятную ошибку.

Куда сохраняется: ASK_SCREENSHOT_DIR, иначе <корень проекта>/.ask-screenshots (корень — как у office.py).
Свой path должен лежать внутри корня и заканчиваться на .png.
inline=True добавляет картинку прямо в ответ инструмента (уменьшенную до max_width), чтобы модель её увидела.

Внимание: на снимке может быть что угодно, в том числе пароли и личная переписка. Снимает то, что видно на экране сейчас.
Отключить группу целиком: MCP_SKIP_GROUPS=desktop.
"""

import io
import os
import sys
import time
from datetime import datetime
from typing import Any

from .office import _fail, _ok, _path, _root

DEFAULT_MAX_WIDTH = 1280
MAX_PIXELS = 64_000_000  # защита от огромных областей
_WIN = sys.platform == "win32"


# ---------- платформенный слой (в тестах подменяется) ----------

def _require_win() -> None:
    if not _WIN:
        raise RuntimeError("работа с окнами и мониторами доступна только на Windows")


def _user32():
    import ctypes

    user32 = ctypes.windll.user32
    if not getattr(_user32, "dpi", False):
        try:
            user32.SetProcessDPIAware()  # координаты окон = пикселям экрана
        except Exception:  # noqa: BLE001
            pass
        _user32.dpi = True
    return ctypes, user32


def _win_rect(hwnd: int) -> list[int]:
    """Видимые границы окна без тени: DWM, иначе GetWindowRect."""
    ctypes, user32 = _user32()
    from ctypes import wintypes

    r = wintypes.RECT()
    try:
        # DWMWA_EXTENDED_FRAME_BOUNDS = 9
        if ctypes.windll.dwmapi.DwmGetWindowAttribute(wintypes.HWND(hwnd), 9, ctypes.byref(r), ctypes.sizeof(r)) == 0:
            return [r.left, r.top, r.right, r.bottom]
    except Exception:  # noqa: BLE001
        pass
    user32.GetWindowRect(wintypes.HWND(hwnd), ctypes.byref(r))
    return [r.left, r.top, r.right, r.bottom]


def _list_windows() -> list[dict]:
    """Окна верхнего уровня: hwnd, title, pid, rect [l,t,r,b], visible, minimized, active."""
    _require_win()
    ctypes, user32 = _user32()
    from ctypes import wintypes

    user32.GetForegroundWindow.restype = wintypes.HWND
    fg = user32.GetForegroundWindow() or 0
    out: list[dict] = []
    proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def cb(hwnd, _lparam):
        hwnd = int(hwnd or 0)
        n = user32.GetWindowTextLengthW(wintypes.HWND(hwnd))
        if not n:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(wintypes.HWND(hwnd), buf, n + 1)
        cloaked = ctypes.c_int(0)
        try:  # DWMWA_CLOAKED = 14: окна UWP на других рабочих столах
            ctypes.windll.dwmapi.DwmGetWindowAttribute(wintypes.HWND(hwnd), 14, ctypes.byref(cloaked), 4)
        except Exception:  # noqa: BLE001
            pass
        pid = wintypes.DWORD(0)
        user32.GetWindowThreadProcessId(wintypes.HWND(hwnd), ctypes.byref(pid))
        out.append({
            "hwnd": hwnd, "title": buf.value, "pid": int(pid.value), "rect": _win_rect(hwnd),
            "visible": bool(user32.IsWindowVisible(wintypes.HWND(hwnd))) and not cloaked.value,
            "minimized": bool(user32.IsIconic(wintypes.HWND(hwnd))), "active": hwnd == int(fg),
        })
        return True

    user32.EnumWindows(proc(cb), 0)
    return out


def _foreground() -> dict | None:
    return next((w for w in _list_windows() if w["active"]), None)


def _focus(hwnd: int) -> bool:
    """Вывести окно на передний план (свёрнутое восстанавливается). True, если окно стало активным."""
    _require_win()
    ctypes, user32 = _user32()
    from ctypes import wintypes

    h = wintypes.HWND(hwnd)
    if user32.IsIconic(h):
        user32.ShowWindow(h, 9)  # SW_RESTORE
    # Windows не пускает чужой процесс на передний план без «нажатия» Alt.
    user32.keybd_event(0x12, 0, 0, 0)
    user32.SetForegroundWindow(h)
    user32.keybd_event(0x12, 0, 2, 0)
    time.sleep(0.3)
    user32.GetForegroundWindow.restype = wintypes.HWND
    return int(user32.GetForegroundWindow() or 0) == hwnd


def _monitors() -> list[dict]:
    """Мониторы: index (с 1), primary, rect [l,t,r,b]."""
    if not _WIN:
        w, h = _grab(None).size
        return [{"index": 1, "primary": True, "rect": [0, 0, w, h]}]
    ctypes, user32 = _user32()
    from ctypes import wintypes

    class MONITORINFO(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT), ("rcWork", wintypes.RECT),
                    ("dwFlags", wintypes.DWORD)]

    found: list[dict] = []
    proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HANDLE, wintypes.HDC, ctypes.POINTER(wintypes.RECT),
                              wintypes.LPARAM)

    def cb(hmon, _hdc, _rect, _lparam):
        info = MONITORINFO()
        info.cbSize = ctypes.sizeof(info)
        user32.GetMonitorInfoW(hmon, ctypes.byref(info))
        r = info.rcMonitor
        found.append({"primary": bool(info.dwFlags & 1), "rect": [r.left, r.top, r.right, r.bottom]})
        return True

    user32.EnumDisplayMonitors(None, None, proc(cb), 0)
    found.sort(key=lambda m: (not m["primary"], m["rect"][0], m["rect"][1]))  # основной первым
    return [{"index": i, **m} for i, m in enumerate(found, 1)]


def _grab(bbox: list[int] | None):
    """Снимок экрана (PIL.Image). bbox=None — все мониторы."""
    from PIL import ImageGrab

    kwargs: dict[str, Any] = {"all_screens": True} if _WIN else {}
    return ImageGrab.grab(bbox=tuple(bbox) if bbox else None, **kwargs).convert("RGB")


# ---------- общая часть ----------

def _out_path(path: str | None, prefix: str) -> str:
    if path:
        return _path(path, ".png")
    base = os.environ.get("ASK_SCREENSHOT_DIR") or os.path.join(_root(), ".ask-screenshots")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")[:-3]
    return os.path.join(os.path.abspath(base), f"{prefix}-{stamp}.png")


def _shot(bbox: list[int] | None, prefix: str, path: str | None, inline: bool, max_width: int, **meta: Any):
    """Снять bbox, сохранить PNG. Ответ — JSON; при inline ещё и картинка."""
    if bbox is not None:
        w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
        if w <= 0 or h <= 0:
            raise ValueError(f"пустая область: {bbox}")
        if w * h > MAX_PIXELS:
            raise ValueError(f"область слишком велика: {w}x{h}")
    full = _out_path(path, prefix)
    img = _grab(bbox)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    img.save(full, "PNG")
    info = {"path": full, "width": img.width, "height": img.height, "bytes": os.path.getsize(full), **meta}
    text = _ok(**info)
    if not inline:
        return text
    from mcp.server.fastmcp import Image

    small = img
    if max_width and img.width > max_width:
        small = img.resize((max_width, max(1, round(img.height * max_width / img.width))))
    buf = io.BytesIO()
    small.save(buf, "PNG")
    return [text, Image(data=buf.getvalue(), format="png")]


def _find(title: str | None, hwnd: int | None, exact: bool, include_minimized: bool = True) -> tuple[dict, int]:
    """Окно по hwnd или заголовку (подстрока без регистра; exact — полное совпадение). Возвращает (окно, число совпадений)."""
    wins = _list_windows()
    if hwnd:
        hit = [w for w in wins if w["hwnd"] == int(hwnd)]
    else:
        t = (title or "").strip().lower()
        if not t:
            raise ValueError("нужен title или hwnd")
        hit = [w for w in wins if (w["title"].lower() == t if exact else t in w["title"].lower())]
    hit = [w for w in hit if w["visible"] and (include_minimized or not w["minimized"])]
    if not hit:
        raise LookupError(f"окно не найдено: {title or hwnd}. Список окон: list_windows")

    def area(w):
        r = w["rect"]
        return max(0, r[2] - r[0]) * max(0, r[3] - r[1])

    hit.sort(key=lambda w: (not w["active"], w["minimized"], -area(w)))
    return hit[0], len(hit)


def _window_shot(win: dict, matches: int, prefix: str, path, inline, max_width, focus: bool):
    focused = None
    if focus:
        focused = _focus(win["hwnd"])
        win = next((w for w in _list_windows() if w["hwnd"] == win["hwnd"]), win)
    if win["minimized"]:
        raise RuntimeError("окно свёрнуто: снимать нечего (focus=True его восстановит)")
    return _shot(win["rect"], prefix, path, inline, max_width,
                 window={"hwnd": win["hwnd"], "title": win["title"], "pid": win["pid"]},
                 matches=matches, focused=focused)


# ---------- инструменты ----------

def list_windows(title_contains: str | None = None, include_hidden: bool = False) -> str:
    """Окна верхнего уровня (только Windows): hwnd, title, pid, rect [лево, верх, право, низ], minimized, active.

    title_contains: фильтр по заголовку (подстрока без учёта регистра). include_hidden: показать и невидимые окна.
    """
    try:
        t = (title_contains or "").strip().lower()
        wins = [w for w in _list_windows() if (include_hidden or w["visible"]) and t in w["title"].lower()]
        return _ok(count=len(wins), windows=wins)
    except Exception as e:  # noqa: BLE001
        return _fail(e)


def list_monitors() -> str:
    """Мониторы: index (с 1; 0 в screenshot_screen — все сразу), primary, rect [лево, верх, право, низ] в пикселях."""
    try:
        return _ok(monitors=_monitors())
    except Exception as e:  # noqa: BLE001
        return _fail(e)


def get_active_window() -> str:
    """Какое окно активно сейчас (только Windows): hwnd, title, pid, rect. Ничего не снимает."""
    try:
        _require_win()
        w = _foreground()
        return _ok(window=w) if w else _ok(window=None, note="активного окна нет")
    except Exception as e:  # noqa: BLE001
        return _fail(e)


def screenshot_screen(monitor: int = 0, path: str | None = None, inline: bool = False,
                      max_width: int = DEFAULT_MAX_WIDTH):
    """Скриншот экрана в PNG. monitor: 0 — все мониторы вместе, 1... — номер из list_monitors.

    path: куда сохранить (внутри корня проекта, .png); по умолчанию .ask-screenshots/. inline: приложить картинку
    к ответу (уменьшенную до max_width), чтобы её увидела модель. Файл всегда полного размера.
    """
    try:
        bbox = None
        if monitor:
            mons = _monitors()
            m = next((x for x in mons if x["index"] == monitor), None)
            if not m:
                raise ValueError(f"нет монитора {monitor}; есть 1..{len(mons)}")
            bbox = m["rect"]
        return _shot(bbox, f"screen{monitor or ''}", path, inline, max_width, monitor=monitor)
    except Exception as e:  # noqa: BLE001
        return _fail(e)


def screenshot_region(x: int, y: int, width: int, height: int, path: str | None = None, inline: bool = False,
                      max_width: int = DEFAULT_MAX_WIDTH):
    """Скриншот прямоугольника экрана: левый верхний угол (x, y), размер width x height, в пикселях (на нескольких
    мониторах x и y могут быть отрицательными — см. rect в list_monitors)."""
    try:
        return _shot([x, y, x + width, y + height], "region", path, inline, max_width)
    except Exception as e:  # noqa: BLE001
        return _fail(e)


def screenshot_active_window(path: str | None = None, inline: bool = False, max_width: int = DEFAULT_MAX_WIDTH):
    """Скриншот активного окна (только Windows). Обратите внимание: активным может оказаться окно самого Cline или терминала."""
    try:
        _require_win()
        w = _foreground()
        if not w:
            raise LookupError("активного окна нет")
        return _window_shot(w, 1, "active", path, inline, max_width, focus=False)
    except Exception as e:  # noqa: BLE001
        return _fail(e)


def screenshot_window(title: str | None = None, hwnd: int | None = None, exact: bool = False, focus: bool = True,
                      path: str | None = None, inline: bool = False, max_width: int = DEFAULT_MAX_WIDTH):
    """Скриншот окна по заголовку или по hwnd из list_windows (только Windows).

    title: подстрока заголовка без учёта регистра; exact=True — полное совпадение. Если окон несколько, берётся
    активное, затем самое большое (число совпадений в поле matches). focus=True выводит окно на передний план
    (свёрнутое восстанавливается), иначе на снимок попадёт то, что перекрывает окно.
    """
    try:
        _require_win()
        w, n = _find(title, hwnd, exact)
        return _window_shot(w, n, "window", path, inline, max_width, focus=focus)
    except Exception as e:  # noqa: BLE001
        return _fail(e)


def focus_window(title: str | None = None, hwnd: int | None = None, exact: bool = False) -> str:
    """Вывести окно на передний план (только Windows); свёрнутое восстанавливается. Не печатает и не кликает.
    Ответ: focused=false, если Windows не пустила окно на передний план."""
    try:
        _require_win()
        w, n = _find(title, hwnd, exact)
        return _ok(window={"hwnd": w["hwnd"], "title": w["title"]}, matches=n, focused=_focus(w["hwnd"]))
    except Exception as e:  # noqa: BLE001
        return _fail(e)


TOOLS = [list_windows, list_monitors, get_active_window, screenshot_screen, screenshot_region,
         screenshot_active_window, screenshot_window, focus_window]
