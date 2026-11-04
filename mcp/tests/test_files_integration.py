"""Интеграция files + analyze: инструменты MCP -> настоящий Node-сервер -> поддельный сайт, на настоящих .xlsx, .pdf, .py.

Стенд запускает `node test/stack.mjs` (сервер и поддельный сайт на свободном порту, файлы во временной папке).
Нет node или проекта рядом — тесты пропускаются.
"""

import asyncio
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from ask_mcp.tools import analysis, tasks

PROJECT = Path(__file__).resolve().parents[2]
STACK = PROJECT / "test" / "stack.mjs"
NODE = shutil.which("node")

pytestmark = pytest.mark.skipif(not (NODE and STACK.exists()), reason="нужны node и project/test/stack.mjs")


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(scope="module")
def stack():
    proc = subprocess.Popen([NODE, str(STACK)], cwd=PROJECT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True, encoding="utf-8")
    try:
        info = json.loads(proc.stdout.readline())
        yield info
    finally:
        try:
            proc.stdin.close()
            proc.wait(timeout=10)
        except Exception:
            proc.kill()


@pytest.fixture(autouse=True)
def _local_url(stack, monkeypatch):
    monkeypatch.setenv("ASK_LOCAL_URL", stack["url"])


def _can_read_pdf() -> bool:
    return shutil.which("pdftotext") is not None


def test_analyze_read_xlsx(stack):
    out = json.loads(run(analysis.analyze("hello.xlsx", "опиши таблицу")))
    assert "hello.xlsx: --- Sheet: Sales ---" in out["text"]
    assert "Apple" in out["text"]


def test_analyze_read_py(stack):
    out = json.loads(run(analysis.analyze("calc.py", "ревью")))
    assert "calc.py: def add(a, b)" in out["text"]


@pytest.mark.skipif(not _can_read_pdf(), reason="нет pdftotext (poppler)")
def test_analyze_read_pdf(stack):
    out = json.loads(run(analysis.analyze("input.pdf", "кратко")))
    assert "Quarterly revenue grew by twelve percent" in out["text"]


def test_wrappers_send_the_file(stack):
    for fn in (analysis.review, analysis.summarize, analysis.explain):
        out = json.loads(run(fn("calc.py")))
        assert "calc.py" in out["text"], fn.__name__


def test_ask_with_three_files(stack):
    files = ["hello.xlsx", "calc.py"] + (["input.pdf"] if _can_read_pdf() else [])
    out = run(tasks.ask("сравни", files=files))
    for name in files:
        assert name in out


def test_analyze_write_creates_report_xlsx(stack):
    report = Path(stack["dir"]) / "report.xlsx"
    report.unlink(missing_ok=True)
    out = json.loads(run(analysis.analyze("hello.xlsx", "проанализируй и создай REPORT", mode="write")))
    assert out["output_files"] == ["report.xlsx"]
    assert "Apple" in out["answer"]
    assert report.exists()


def test_execute_with_files_returns_output_files(stack):
    (Path(stack["dir"]) / "report.xlsx").unlink(missing_ok=True)
    out = json.loads(run(tasks.execute("сделай REPORT по таблице", files=["hello.xlsx"])))
    assert out["output_files"] == ["report.xlsx"]


def test_report_can_be_read_back(stack):
    (Path(stack["dir"]) / "report.xlsx").unlink(missing_ok=True)
    made = json.loads(run(analysis.analyze("hello.xlsx", "создай REPORT", mode="write")))
    back = json.loads(run(analysis.analyze(made["output_files"][0], "что в отчёте")))
    assert "Apple" in back["text"]


def test_refused_files_give_a_clear_error(stack):
    from ask_mcp.errors import AskError
    for bad in (".env", "../outside.xlsx", "nope.xlsx"):
        with pytest.raises(AskError):
            run(analysis.analyze(bad, "x"))
