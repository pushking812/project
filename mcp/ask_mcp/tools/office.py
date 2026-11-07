"""Файлы Office: чтение и правка .xlsx (openpyxl) и .docx (python-docx). Работают локально, без HTTP API.

Папка проекта: ASK_OFFICE_ROOT, иначе рабочая папка сервера (GET /workspace, меняется через set_workspace), иначе ASK_CODE_ROOT, иначе корень репозитория. Путь: относительный или абсолютный (внутри корня; вне корня только при ASK_OFFICE_ALLOW_ANY_PATH=1).
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


def _server_root() -> str | None:
    """Рабочая папка нашего сервера (GET /workspace). Сервер не отвечает или ответ странный: None."""
    try:
        import httpx

        from ..config import local_api_url

        r = httpx.get(local_api_url() + "/workspace", timeout=2.0)
        root = r.json().get("root") if r.status_code == 200 else None
        return root if isinstance(root, str) and root else None
    except Exception:  # noqa: BLE001
        return None


def _root() -> str:
    """ASK_OFFICE_ROOT, если задан; иначе рабочая папка сервера (та же, что у analyze и files); иначе ASK_CODE_ROOT или корень репозитория."""
    explicit = os.environ.get("ASK_OFFICE_ROOT")
    if explicit:
        return os.path.abspath(explicit)
    return os.path.abspath(_server_root() or os.environ.get("ASK_CODE_ROOT") or _REPO_ROOT)


def _path(path: str, ext: str) -> str:
    clean = (path or "").replace("\\", "/").strip()
    if not clean:
        raise ValueError("path не задан")
    root = _root()
    is_abs = clean.startswith("/") or (len(clean) > 1 and clean[1] == ":")
    full = os.path.abspath(clean if is_abs else os.path.join(root, clean))
    inside = full == root or os.path.normcase(full).startswith(os.path.normcase(root) + os.sep)
    if not inside and os.environ.get("ASK_OFFICE_ALLOW_ANY_PATH") != "1":
        raise ValueError(f"путь вне корня {root}: {path} (расширить: ASK_OFFICE_ROOT или ASK_OFFICE_ALLOW_ANY_PATH=1)")
    if is_abs:
        clean = full.replace("\\", "/")
    if any(p.lower() in DENY for p in clean.split("/")):
        raise ValueError(f"доступ запрещён: {path}")
    if not full.lower().endswith(ext):
        raise ValueError(f"нужен файл {ext}: {path}")
    return full


def _excel_path(path: str) -> str:
    """Путь к книге Excel: .xlsx или .xlsm."""
    clean = (path or "").strip().lower()
    return _path(path, ".xlsm" if clean.endswith(".xlsm") else ".xlsx")


def _word_path(path: str) -> str:
    """Путь к документу Word: .docx или .docm."""
    clean = (path or "").strip().lower()
    return _path(path, ".docm" if clean.endswith(".docm") else ".docx")


_DOCX_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
_DOCM_CT = "application/vnd.ms-word.document.macroEnabled.main+xml"


def _swap_ct(data: bytes, old: str, new: str) -> bytes:
    """Заменить тип основной части в [Content_Types].xml (остальные части архива не меняются)."""
    import io
    import zipfile

    src = zipfile.ZipFile(io.BytesIO(data))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            body = src.read(item.filename)
            if item.filename == "[Content_Types].xml":
                body = body.decode("utf-8").replace(old, new).encode("utf-8")
            dst.writestr(item, body)
    return out.getvalue()


def _word_open(docx, full: str):
    """Открыть .docx или .docm (для .docm тип основной части временно подменяется, vbaProject.bin сохраняется)."""
    if not full.lower().endswith(".docm"):
        return docx.Document(full)
    import io

    with open(full, "rb") as f:
        return docx.Document(io.BytesIO(_swap_ct(f.read(), _DOCM_CT, _DOCX_CT)))


def _word_save(doc, full: str) -> None:
    if not full.lower().endswith(".docm"):
        doc.save(full)
        return
    import io

    buf = io.BytesIO()
    doc.save(buf)
    with open(full, "wb") as f:
        f.write(_swap_ct(buf.getvalue(), _DOCX_CT, _DOCM_CT))


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

def read_excel(path: str, sheet: str | None = None, cell_range: str | None = None,
               max_rows: int = 200, values_only: bool = False) -> str:
    """Прочитать книгу Excel (.xlsx, .xlsm). Без sheet — первый лист; список листов приходит всегда.

    cell_range: "A1:D20" (по умолчанию весь диапазон). Формулы — текстом; values_only=true — сохранённые значения.
    """
    try:
        openpyxl = _need("openpyxl", "openpyxl")
        full = _excel_path(path)
        wb = openpyxl.load_workbook(full, data_only=values_only, keep_vba=full.lower().endswith(".xlsm"))
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


def write_excel(path: str, cells: dict[str, Any] | None = None, rows: list[list[Any]] | None = None,
                sheet: str | None = None, start_cell: str = "A1", create_sheet: bool = True) -> str:
    """Создать или изменить книгу Excel (.xlsx, .xlsm; остальное содержимое и макросы сохраняются).

    cells: {"B2": 10, "C2": "=B2*2"}; строка с "=" — формула. rows: блок строк от start_cell.
    sheet: имя листа (по умолчанию первый); create_sheet: создать, если нет.
    """
    try:
        openpyxl = _need("openpyxl", "openpyxl")
        from openpyxl.utils.cell import coordinate_from_string, column_index_from_string

        if not cells and not rows:
            raise ValueError("нужны cells или rows")
        full = _excel_path(path)
        macro = full.lower().endswith(".xlsm")
        existed = os.path.isfile(full)
        if existed:
            wb = openpyxl.load_workbook(full, keep_vba=macro)
        else:
            if macro:
                raise ValueError("новый .xlsm создайте через Excel или write_vba; здесь можно менять только существующий")
            wb = openpyxl.Workbook()
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


def read_word(path: str, max_paragraphs: int = 500) -> str:
    """Прочитать документ Word (.docx или .docm): абзацы (с номером, стилем) и таблицы (строки ячеек)."""
    try:
        docx = _need("docx", "python-docx")
        doc = _word_open(docx, _word_path(path))
        paras = [{"i": i, "style": p.style.name if p.style is not None else None, "text": p.text}
                 for i, p in enumerate(doc.paragraphs)]
        truncated = len(paras) > max_paragraphs
        tables = [[[c.text for c in row.cells] for row in t.rows] for t in doc.tables]
        return _ok(paragraphs=paras[:max(1, int(max_paragraphs))], truncated=truncated, tables=tables)
    except Exception as e:  # noqa: BLE001
        return _fail(e)


def edit_word(path: str, replacements: list[dict[str, str]] | None = None,
              append_paragraphs: list[str] | None = None, insert_after: int | None = None,
              heading_level: int | None = None, table_rows: list[list[str]] | None = None) -> str:
    """Изменить документ Word (.docx, .docm; макросы сохраняются) или создать .docx.

    replacements: [{"old","new"}] — замена в тексте, таблицах, колонтитулах.
    append_paragraphs: абзацы в конец или после абзаца insert_after (номер из read_word); heading_level 1–9 — заголовки.
    table_rows: таблица в конец (строки ячеек).
    """
    try:
        docx = _need("docx", "python-docx")
        full = _word_path(path)
        existed = os.path.isfile(full)
        if not existed and full.lower().endswith(".docm"):
            raise ValueError("новый .docm создайте через Word или write_vba; здесь можно менять только существующий")
        doc = _word_open(docx, full) if existed else docx.Document()
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
        _word_save(doc, full)
        return _ok(path=path, created=not existed, replacements=report, paragraphs_added=added,
                   table_added=bool(table_rows))
    except Exception as e:  # noqa: BLE001
        return _fail(e)


TOOLS = [read_excel, write_excel, read_word, edit_word]
