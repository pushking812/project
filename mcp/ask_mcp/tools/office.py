"""Файлы Office: чтение и правка .xlsx (openpyxl) и .docx (python-docx). Работают локально, без HTTP API.

Папка проекта: ASK_OFFICE_ROOT, иначе ASK_CODE_ROOT, иначе корень репозитория. Пути только относительные.
Библиотеки подключаются при вызове: без них сервер стартует, а инструмент вернёт понятную ошибку.
Ограничение: openpyxl и python-docx не сохраняют часть содержимого (диаграммы, картинки в xlsx, макросы).
"""

import json
import os
from datetime import date, datetime, time
from typing import Any

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
DENY = {".env", ".git", ".venv", "__pycache__"}
MAX_CELLS = 5000


def _root() -> str:
    return os.path.abspath(os.environ.get("ASK_OFFICE_ROOT") or os.environ.get("ASK_CODE_ROOT") or _REPO_ROOT)


def _path(path: str, ext: str) -> str:
    clean = (path or "").replace("\\", "/").strip()
    if not clean:
        raise ValueError("path не задан")
    if clean.startswith("/") or (len(clean) > 1 and clean[1] == ":"):
        raise ValueError(f"абсолютный путь запрещён: {path}")
    root = _root()
    full = os.path.abspath(os.path.join(root, clean))
    if full != root and not full.startswith(root + os.sep):
        raise ValueError(f"путь вне проекта: {path}")
    if any(p.lower() in DENY for p in clean.split("/")):
        raise ValueError(f"доступ запрещён: {path}")
    if not full.lower().endswith(ext):
        raise ValueError(f"нужен файл {ext}: {path}")
    return full


def _ok(**data: Any) -> str:
    return json.dumps({"ok": True, **data}, ensure_ascii=False, default=str)


def _fail(e: Exception) -> str:
    return json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False)


def _need(module: str, package: str):
    try:
        return __import__(module)
    except ImportError:
        raise RuntimeError(f"не установлен {package}: pip install {package} (в .venv проекта)") from None


def _plain(v: Any) -> Any:
    if isinstance(v, (datetime, date, time)):
        return v.isoformat()
    return v


# ---------- xlsx ----------

def read_xlsx(path: str, sheet: str | None = None, cell_range: str | None = None,
              max_rows: int = 200, values_only: bool = False) -> str:
    """Прочитать .xlsx. Без sheet — первый лист; список всех листов возвращается всегда.

    cell_range: например "A1:D20" (по умолчанию весь занятый диапазон). max_rows: лимит строк.
    Формулы возвращаются текстом ("=SUM(A1:A3)"); values_only=true — вычисленные значения, сохранённые Excel.
    """
    try:
        openpyxl = _need("openpyxl", "openpyxl")
        wb = openpyxl.load_workbook(_path(path, ".xlsx"), data_only=values_only)
        names = wb.sheetnames
        ws = wb[sheet] if sheet else wb[names[0]]
        area = ws[cell_range] if cell_range else ws.iter_rows()
        if not isinstance(area, (tuple, list)) and not hasattr(area, "__next__"):
            area = ((area,),)  # одна ячейка
        rows, cells = [], 0
        truncated = False
        for row in area:
            row = row if isinstance(row, (tuple, list)) else (row,)
            if len(rows) >= max(1, int(max_rows)) or cells + len(row) > MAX_CELLS:
                truncated = True
                break
            cells += len(row)
            rows.append([_plain(c.value) for c in row])
        first = cell_range.split(":")[0].replace("$", "") if cell_range else "A1"
        return _ok(sheets=names, sheet=ws.title, dimensions=ws.dimensions, first_cell=first,
                   rows=rows, truncated=truncated)
    except Exception as e:  # noqa: BLE001
        return _fail(e)


def write_xlsx(path: str, cells: dict[str, Any] | None = None, rows: list[list[Any]] | None = None,
               sheet: str | None = None, start_cell: str = "A1", create_sheet: bool = True) -> str:
    """Создать или изменить .xlsx. Остальное содержимое существующего файла сохраняется.

    cells: {"B2": 10, "C2": "=B2*2"} — значения по адресам; строка с "=" в начале становится формулой.
    rows: список строк, пишется блоком от start_cell. sheet: имя листа (по умолчанию первый или новый "Sheet").
    create_sheet: создать лист, если его нет.
    """
    try:
        openpyxl = _need("openpyxl", "openpyxl")
        from openpyxl.utils.cell import coordinate_from_string, column_index_from_string

        if not cells and not rows:
            raise ValueError("нужны cells или rows")
        full = _path(path, ".xlsx")
        existed = os.path.isfile(full)
        wb = openpyxl.load_workbook(full) if existed else openpyxl.Workbook()
        if sheet and sheet not in wb.sheetnames:
            if not create_sheet:
                raise ValueError(f"лист не найден: {sheet}; есть: {wb.sheetnames}")
            if not existed and wb.sheetnames == ["Sheet"] and wb["Sheet"].max_row == 1 and wb["Sheet"]["A1"].value is None:
                wb["Sheet"].title = sheet
            else:
                wb.create_sheet(sheet)
        ws = wb[sheet] if sheet else wb[wb.sheetnames[0]]
        count = 0
        for addr, value in (cells or {}).items():
            ws[addr] = value
            count += 1
        if rows:
            col_letter, row0 = coordinate_from_string(start_cell)
            col0 = column_index_from_string(col_letter)
            for i, r in enumerate(rows):
                for j, value in enumerate(r):
                    ws.cell(row=row0 + i, column=col0 + j, value=value)
                    count += 1
        os.makedirs(os.path.dirname(full), exist_ok=True)
        wb.save(full)
        return _ok(path=path, sheet=ws.title, cells_written=count, created=not existed, sheets=wb.sheetnames)
    except Exception as e:  # noqa: BLE001
        return _fail(e)


# ---------- docx ----------

def _iter_paragraphs(doc):
    """Абзацы тела, таблиц (в том числе вложенных), колонтитулов."""
    def from_tables(tables):
        for t in tables:
            for row in t.rows:
                for cell in row.cells:
                    yield from cell.paragraphs
                    yield from from_tables(cell.tables)

    yield from doc.paragraphs
    yield from from_tables(doc.tables)
    for s in doc.sections:
        for part in (s.header, s.footer):
            yield from part.paragraphs
            yield from from_tables(part.tables)


def _replace_in_paragraph(p, old: str, new: str) -> int:
    """Замена во всех вхождениях абзаца. Сначала по отдельным runs (форматирование цело),
    если фрагмент разбит между runs — собирает текст в первом run."""
    if old not in p.text:
        return 0
    n = 0
    for r in p.runs:
        if old in r.text:
            n += r.text.count(old)
            r.text = r.text.replace(old, new)
    if old in p.text and p.runs:
        n += p.text.count(old)
        full = p.text.replace(old, new)
        p.runs[0].text = full
        for r in p.runs[1:]:
            r.text = ""
    return n


def read_docx(path: str, max_paragraphs: int = 500) -> str:
    """Прочитать .docx: абзацы (с номером, стилем) и таблицы (строки ячеек)."""
    try:
        docx = _need("docx", "python-docx")
        doc = docx.Document(_path(path, ".docx"))
        paras = [{"i": i, "style": p.style.name if p.style is not None else None, "text": p.text}
                 for i, p in enumerate(doc.paragraphs)]
        truncated = len(paras) > max_paragraphs
        tables = [[[c.text for c in row.cells] for row in t.rows] for t in doc.tables]
        return _ok(paragraphs=paras[:max(1, int(max_paragraphs))], truncated=truncated, tables=tables)
    except Exception as e:  # noqa: BLE001
        return _fail(e)


def edit_docx(path: str, replacements: list[dict[str, str]] | None = None,
              append_paragraphs: list[str] | None = None, insert_after: int | None = None,
              heading_level: int | None = None, table_rows: list[list[str]] | None = None) -> str:
    """Изменить или создать .docx.

    replacements: [{"old": "...", "new": "..."}] — замена текста в абзацах, таблицах, колонтитулах.
    append_paragraphs: новые абзацы в конец, либо после абзаца с номером insert_after (номер из read_docx).
    heading_level: 1–9 — оформить добавляемые абзацы как заголовки.
    table_rows: добавить таблицу в конец документа (список строк из ячеек).
    Файла нет — создаётся новый документ.
    """
    try:
        docx = _need("docx", "python-docx")
        full = _path(path, ".docx")
        existed = os.path.isfile(full)
        doc = docx.Document(full) if existed else docx.Document()
        if not (replacements or append_paragraphs or table_rows):
            raise ValueError("нужны replacements, append_paragraphs или table_rows")
        report = []
        for item in replacements or []:
            old, new = item.get("old", ""), item.get("new", "")
            if not old:
                raise ValueError("в replacements пустое old")
            n = sum(_replace_in_paragraph(p, old, new) for p in _iter_paragraphs(doc))
            report.append({"old": old, "replaced": n})
        added = 0
        if append_paragraphs:
            anchor = None
            if insert_after is not None:
                if not 0 <= insert_after < len(doc.paragraphs):
                    raise ValueError(f"нет абзаца {insert_after}; всего {len(doc.paragraphs)}")
                anchor = doc.paragraphs[insert_after]
            for text in append_paragraphs:
                if anchor is None:
                    if heading_level:
                        doc.add_heading(text, level=int(heading_level))
                    else:
                        doc.add_paragraph(text)
                else:
                    # Абзац создаётся в конце документа и переносится сразу после якоря.
                    new_p = doc.add_paragraph(text)
                    if heading_level:
                        new_p.style = doc.styles[f"Heading {int(heading_level)}"]
                    anchor._p.addnext(new_p._p)
                    anchor = new_p
                added += 1
        if table_rows:
            cols = max(len(r) for r in table_rows)
            table = doc.add_table(rows=len(table_rows), cols=cols)
            for i, r in enumerate(table_rows):
                for j, v in enumerate(r):
                    table.cell(i, j).text = str(v)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        doc.save(full)
        return _ok(path=path, created=not existed, replacements=report, paragraphs_added=added,
                   table_added=bool(table_rows))
    except Exception as e:  # noqa: BLE001
        return _fail(e)


TOOLS = [read_xlsx, write_xlsx, read_docx, edit_docx]
