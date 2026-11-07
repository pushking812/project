"""Каталог инструментов в прокси: ужатие схем, исключение родных имён, список от клиента; группы MCP."""
import json

import pytest

import openai_proxy
from ask_mcp import tools as ask_tools


def test_slim_drops_title_null_default_and_null_variant():
    schema = {
        "title": "xArguments", "type": "object", "required": ["a"],
        "properties": {
            "a": {"title": "A", "type": "string"},
            "b": {"title": "B", "anyOf": [{"type": "integer"}, {"type": "null"}], "default": None},
            "title": {"type": "string", "default": "x"},
        },
    }
    slim = openai_proxy._slim(schema)
    assert slim == {
        "type": "object", "required": ["a"],
        "properties": {"a": {"type": "string"}, "b": {"type": "integer"}, "title": {"type": "string", "default": "x"}},
    }
    assert schema["properties"]["a"]["title"] == "A"  # исходная схема не изменена


def test_slim_keeps_real_alternatives():
    s = {"anyOf": [{"type": "integer"}, {"type": "string"}, {"type": "null"}]}
    assert openai_proxy._slim(s) == {"anyOf": [{"type": "integer"}, {"type": "string"}]}


def test_excluded_mcp_by_server_and_native_by_prefix():
    skip = ("craft", "=composio_")
    assert openai_proxy._excluded("cadcraft__draw", skip)
    assert openai_proxy._excluded("composio_search_tools", skip)
    assert not openai_proxy._excluded("execute_command", skip)
    assert not openai_proxy._excluded("ask__execute", skip)
    assert not openai_proxy._excluded("read_file", ("craft",))  # без «=» родные имена не трогаются


def _tool(name, params=None):
    return {"type": "function", "function": {"name": name, "description": "d", "parameters": params or {"type": "object"}}}


def test_catalog_excludes_native_and_dumps_names(monkeypatch, tmp_path):
    dump = tmp_path / "seen.txt"
    monkeypatch.setenv("PROXY_TOOLS_DUMP", str(dump))
    monkeypatch.setenv("PROXY_TOOL_EXCLUDE", "craft,=composio_")
    monkeypatch.setattr(openai_proxy._dump_names, "last", None, raising=False)
    text, sent, dropped = openai_proxy._tools_catalog(
        [_tool("composio_search_tools"), _tool("read_file"), _tool("ask__ask"), _tool("wordcraft__x")])
    assert sent == 2 and not dropped
    assert "composio_search_tools" not in text and "read_file" in text and "ask__ask" in text
    seen = dump.read_text(encoding="utf-8")
    assert "composio_search_tools   [исключён]" in seen and "wordcraft__x   [исключён]" in seen
    assert "read_file   [" not in seen


def test_catalog_slims_schema_and_can_be_switched_off(monkeypatch):
    params = {"title": "T", "type": "object", "properties": {"a": {"title": "A", "type": "string"}}}
    on, _, _ = openai_proxy._tools_catalog([_tool("t", params)])
    assert '"title"' not in on
    monkeypatch.setenv("PROXY_SLIM_SCHEMA", "off")
    off, _, _ = openai_proxy._tools_catalog([_tool("t", params)])
    assert json.dumps(params, separators=(",", ":")) in off


def test_ask_office_goes_right_after_ask():
    text, _, _ = openai_proxy._tools_catalog([_tool("other__x"), _tool("ask-extra__browser_open"), _tool("ask__ask")])
    assert text.index("ask__ask") < text.index("ask-extra__browser_open") < text.index("other__x")


def test_groups_parse_and_split():
    assert ask_tools.parse_groups(" Office, vba ") == ["office", "vba"]
    assert ask_tools.parse_groups("") == []
    with pytest.raises(ValueError):
        ask_tools.parse_groups("office,nope")
    office = {f.__name__ for f in ask_tools.all_tools(only=["office", "vba"])}
    rest = {f.__name__ for f in ask_tools.all_tools(skip=["office", "vba"])}
    everything = {f.__name__ for f in ask_tools.all_tools()}
    assert office and rest and not office & rest and office | rest == everything
