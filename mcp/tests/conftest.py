"""Общие настройки тестов: результат не должен зависеть от ASK.md, который лежит в папке проекта."""
import pytest


@pytest.fixture(autouse=True)
def _no_project_notes(monkeypatch):
    # Тесты о заметках проекта задают PROXY_NOTES_FILE сами (monkeypatch внутри теста перекрывает эту фикстуру).
    monkeypatch.setenv("PROXY_NOTES_FILE", "off")


@pytest.fixture(autouse=True)
def _no_tools_dump(monkeypatch):
    # Прокси пишет список инструментов клиента в файл; тесты его не создают (свой путь задаёт сам тест).
    monkeypatch.setenv("PROXY_TOOLS_DUMP", "off")


@pytest.fixture(autouse=True)
def _default_backend(monkeypatch):
    # Режим прокси в mcp\.env (PROXY_BACKEND=code) не должен менять результат тестов; свои тесты задают его сами.
    monkeypatch.setenv("PROXY_BACKEND", "ask")
    monkeypatch.delenv("PROXY_CODE_MODE", raising=False)


@pytest.fixture(autouse=True)
def _no_autosession(monkeypatch, tmp_path):
    # Автосессия по умолчанию выключена и не трогает настоящий файл пользователя; тесты автосессии включают её сами.
    from ask_mcp import autosession
    monkeypatch.setenv("ASK_SESSION_AUTO", "false")
    monkeypatch.setenv("ASK_SESSION_FILE", str(tmp_path / "mcp-session.json"))
    monkeypatch.delenv("ASK_SESSION_ID", raising=False)
    autosession.reset()
    yield
    autosession.reset()
