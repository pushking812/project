"""Группа desktop: скриншоты и окна. Платформенный слой (_list_windows, _grab и т. д.) подменяется."""

import json

import pytest

from ask_mcp import tools as ask_tools
from ask_mcp.tools import desktop

Image = pytest.importorskip("PIL.Image")


def win(hwnd, title, rect=(0, 0, 200, 100), visible=True, minimized=False, active=False):
    return {"hwnd": hwnd, "title": title, "pid": hwnd * 10, "rect": list(rect), "visible": visible,
            "minimized": minimized, "active": active}


@pytest.fixture
def env(monkeypatch, tmp_path):
    monkeypatch.setenv("ASK_OFFICE_ROOT", str(tmp_path))
    monkeypatch.delenv("ASK_SCREENSHOT_DIR", raising=False)
    monkeypatch.setattr(desktop, "_WIN", True)
    def grab(bbox):
        w, h = (bbox[2] - bbox[0], bbox[3] - bbox[1]) if bbox else (3000, 1000)
        return Image.new("RGB", (w, h), "white")

    monkeypatch.setattr(desktop, "_grab", grab)
    monkeypatch.setattr(desktop, "_monitors", lambda: [
        {"index": 1, "primary": True, "rect": [0, 0, 1920, 1080]},
        {"index": 2, "primary": False, "rect": [1920, 0, 3840, 1080]}])
    monkeypatch.setattr(desktop, "_focus", lambda hwnd: True)
    windows = [win(1, "Блокнот - a.txt", (10, 10, 410, 310)),
               win(2, "Notepad++ - b.txt", (0, 0, 800, 600), active=True),
               win(3, "Скрыто", visible=False),
               win(4, "Свёрнутое окно", minimized=True)]
    monkeypatch.setattr(desktop, "_list_windows", lambda: windows)
    return tmp_path


def run(fn, *a, **kw):
    out = fn(*a, **kw)
    return json.loads(out if isinstance(out, str) else out[0])


def test_group_registered():
    names = {f.__name__ for f in ask_tools.all_tools(only=["desktop"])}
    assert names == {"list_windows", "list_monitors", "get_active_window", "screenshot_screen", "screenshot_region",
                     "screenshot_active_window", "screenshot_window", "focus_window"}
    assert not names & {f.__name__ for f in ask_tools.all_tools(skip=["desktop"])}


def test_screen_all_saves_png_in_default_dir(env):
    r = run(desktop.screenshot_screen)
    assert r["ok"] and (r["width"], r["height"]) == (3000, 1000)
    assert r["path"].startswith(str(env)) and ".ask-screenshots" in r["path"] and r["path"].endswith(".png")
    assert Image.open(r["path"]).size == (3000, 1000)


def test_screen_monitor_uses_its_rect_and_checks_index(env):
    r = run(desktop.screenshot_screen, monitor=2)
    assert r["ok"] and (r["width"], r["height"]) == (1920, 1080) and r["monitor"] == 2
    bad = run(desktop.screenshot_screen, monitor=5)
    assert not bad["ok"] and "нет монитора 5" in bad["error"]


def test_region_and_empty_region(env):
    r = run(desktop.screenshot_region, 100, 50, 300, 200)
    assert r["ok"] and (r["width"], r["height"]) == (300, 200)
    assert not run(desktop.screenshot_region, 0, 0, 0, 10)["ok"]
    assert not run(desktop.screenshot_region, 0, 0, 100000, 100000)["ok"]


def test_active_window(env):
    r = run(desktop.screenshot_active_window)
    assert r["ok"] and r["window"]["title"] == "Notepad++ - b.txt" and (r["width"], r["height"]) == (800, 600)


def test_window_by_title_is_case_insensitive_substring(env):
    r = run(desktop.screenshot_window, title="БЛОКНОТ")
    assert r["ok"] and r["window"]["hwnd"] == 1 and r["matches"] == 1 and r["focused"] is True
    assert (r["width"], r["height"]) == (400, 300)


def test_window_exact_and_not_found_and_hidden(env):
    assert run(desktop.screenshot_window, title="Блокнот", exact=True)["ok"] is False
    assert run(desktop.screenshot_window, title="Блокнот - a.txt", exact=True)["ok"]
    assert "окно не найдено" in run(desktop.screenshot_window, title="Скрыто")["error"]  # невидимые не считаются
    assert not run(desktop.screenshot_window)["ok"]  # ни title, ни hwnd


def test_window_by_hwnd_and_several_matches_prefers_active(env):
    assert run(desktop.screenshot_window, hwnd=1)["window"]["title"].startswith("Блокнот")
    r = run(desktop.screenshot_window, title="txt")  # подходят окна 1 и 2
    assert r["matches"] == 2 and r["window"]["hwnd"] == 2


def test_minimized_window_without_focus_fails(env, monkeypatch):
    r = run(desktop.screenshot_window, title="Свёрнутое", focus=False)
    assert not r["ok"] and "свёрнуто" in r["error"]


def test_inline_adds_downscaled_image(env):
    out = desktop.screenshot_screen(inline=True, max_width=600)
    assert isinstance(out, list) and len(out) == 2
    info = json.loads(out[0])
    assert info["width"] == 3000  # файл полного размера
    from io import BytesIO

    assert Image.open(BytesIO(out[1].data)).size == (600, 200)


def test_custom_path_must_be_png_inside_root(env):
    ok = run(desktop.screenshot_region, 0, 0, 10, 10, path="shots/a.png")
    assert ok["ok"] and ok["path"] == str(env / "shots" / "a.png")
    assert not run(desktop.screenshot_region, 0, 0, 10, 10, path="a.txt")["ok"]
    assert not run(desktop.screenshot_region, 0, 0, 10, 10, path="/tmp/../etc/x.png")["ok"]


def test_screenshot_dir_env(env, monkeypatch, tmp_path):
    other = tmp_path / "elsewhere"
    monkeypatch.setenv("ASK_SCREENSHOT_DIR", str(other))
    assert run(desktop.screenshot_region, 0, 0, 5, 5)["path"].startswith(str(other))


def test_list_windows_filters(env):
    assert [w["hwnd"] for w in run(desktop.list_windows)["windows"]] == [1, 2, 4]
    assert [w["hwnd"] for w in run(desktop.list_windows, include_hidden=True)["windows"]] == [1, 2, 3, 4]
    assert [w["hwnd"] for w in run(desktop.list_windows, title_contains="notepad")["windows"]] == [2]


def test_active_and_focus(env):
    assert run(desktop.get_active_window)["window"]["hwnd"] == 2
    r = run(desktop.focus_window, title="Блокнот")
    assert r["ok"] and r["focused"] is True and r["window"]["hwnd"] == 1


def test_window_tools_unsupported_off_windows(env, monkeypatch):
    monkeypatch.setattr(desktop, "_WIN", False)
    for fn, kw in [(desktop.get_active_window, {}), (desktop.screenshot_active_window, {}),
                   (desktop.screenshot_window, {"title": "x"}), (desktop.focus_window, {"title": "x"})]:
        r = run(fn, **kw)
        assert not r["ok"] and "только на Windows" in r["error"]
