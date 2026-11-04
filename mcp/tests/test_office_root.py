"""Корень office-инструментов: ASK_OFFICE_ROOT, затем рабочая папка сервера, затем запасные."""

import os

from ask_mcp.tools import office


def test_explicit_root_wins(monkeypatch, tmp_path):
    monkeypatch.setenv("ASK_OFFICE_ROOT", str(tmp_path))
    monkeypatch.setattr(office, "_server_root", lambda: "/other")
    assert office._root() == os.path.abspath(str(tmp_path))


def test_server_workspace_used(monkeypatch, tmp_path):
    monkeypatch.delenv("ASK_OFFICE_ROOT", raising=False)
    monkeypatch.setattr(office, "_server_root", lambda: str(tmp_path))
    assert office._root() == os.path.abspath(str(tmp_path))


def test_fallback_when_server_down(monkeypatch, tmp_path):
    monkeypatch.delenv("ASK_OFFICE_ROOT", raising=False)
    monkeypatch.setenv("ASK_CODE_ROOT", str(tmp_path))
    monkeypatch.setenv("ASK_LOCAL_URL", "http://127.0.0.1:1")
    assert office._root() == os.path.abspath(str(tmp_path))


def test_paths_resolve_in_server_root(monkeypatch, tmp_path):
    monkeypatch.delenv("ASK_OFFICE_ROOT", raising=False)
    monkeypatch.setattr(office, "_server_root", lambda: str(tmp_path))
    assert office._excel_path("a.xlsx") == os.path.abspath(str(tmp_path / "a.xlsx"))
    assert office._word_path(str(tmp_path / "b.docx")) == os.path.abspath(str(tmp_path / "b.docx"))
