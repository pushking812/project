"""VBA-макросы: просмотр, создание, правка и запуск в .xlsm (Excel) и .docm (Word).

Работает только в Windows, с установленным Microsoft Office и пакетом pywin32 (pip install pywin32).
Нужна настройка Office: «Параметры → Центр управления безопасностью → Параметры макросов →
Доверять доступ к объектной модели проектов VBA» (в реестре AccessVBOM=1). Без неё доступ к коду закрыт.
Каждый вызов запускает отдельный скрытый экземпляр Excel/Word и закрывает его. Файл не должен быть
открыт в другом окне Office.
Пути, корень проекта и список запретных папок — как в office.py (ASK_OFFICE_ROOT).
"""

import os
import sys
from contextlib import contextmanager
from typing import Any

from .office import _fail, _need, _ok, _path

EXTS = (".xlsm", ".docm")
MAX_CODE = 200_000
TYPES = {"standard": 1, "class": 2}
TYPE_NAMES = {1: "standard", 2: "class", 3: "form", 100: "document"}
TRUST_HINT = (
    "нет доступа к проекту VBA. Включите «Доверять доступ к объектной модели проектов VBA» "
    "(Файл → Параметры → Центр управления безопасностью → Параметры центра → Параметры макросов) "
    "или выполните: reg add HKCU\\Software\\Microsoft\\Office\\16.0\\Excel\\Security /v AccessVBOM /t REG_DWORD /d 1 /f "
    "(для Word — ...\\Word\\Security), затем повторите."
)


def _is_excel(full: str) -> bool:
    return full.lower().endswith(".xlsm")


@contextmanager
def _office(full: str, readonly: bool = False, create: bool = False, allow_macros: bool = False):
    """Открывает файл в скрытом Excel/Word; отдаёт (app, doc). Закрывает всё при выходе."""
    if sys.platform != "win32":
        raise RuntimeError("VBA-инструменты работают только в Windows с установленным Office")
    _need("win32com", "pywin32")
    import pythoncom
    import win32com.client as wc

    pythoncom.CoInitialize()
    app = doc = None
    excel = _is_excel(full)
    try:
        app = wc.DispatchEx("Excel.Application" if excel else "Word.Application")
        app.Visible = False
        app.DisplayAlerts = False if excel else 0
        # 1 — макросы разрешены (нужно для запуска), 3 — запрещены (достаточно для чтения и правки кода).
        app.AutomationSecurity = 1 if allow_macros else 3
        if os.path.isfile(full):
            if excel:
                doc = app.Workbooks.Open(full, ReadOnly=readonly)
            else:
                doc = app.Documents.Open(full, ReadOnly=readonly)
        elif create:
            os.makedirs(os.path.dirname(full), exist_ok=True)
            if excel:
                doc = app.Workbooks.Add()
                doc.SaveAs(full, FileFormat=52)  # xlOpenXMLWorkbookMacroEnabled
            else:
                doc = app.Documents.Add()
                doc.SaveAs2(full, FileFormat=13)  # wdFormatXMLDocumentMacroEnabled
        else:
            raise FileNotFoundError(f"файл не найден: {full}")
        yield app, doc
    finally:
        try:
            if doc is not None:
                doc.Close(False)
        except Exception:  # noqa: BLE001
            pass
        try:
            if app is not None:
                app.Quit()
        except Exception:  # noqa: BLE001
            pass
        doc = app = None
        pythoncom.CoUninitialize()


def _project(doc):
    try:
        return doc.VBProject
    except Exception:  # noqa: BLE001
        raise RuntimeError(TRUST_HINT) from None


def _component(proj, name: str):
    for c in proj.VBComponents:
        if c.Name.lower() == name.lower():
            return c
    return None


def _names(proj) -> list[str]:
    return [c.Name for c in proj.VBComponents]


def _code(comp) -> str:
    cm = comp.CodeModule
    n = cm.CountOfLines
    return cm.Lines(1, n).replace("\r\n", "\n").replace("\r", "\n") if n else ""


def _set_code(comp, code: str) -> None:
    cm = comp.CodeModule
    if cm.CountOfLines:
        cm.DeleteLines(1, cm.CountOfLines)
    if code:
        cm.AddFromString(code.replace("\r\n", "\n").replace("\n", "\r\n"))


def list_vba(path: str) -> str:
    """Список модулей VBA в .xlsm/.docm: имя, тип (standard, class, form, document), число строк кода."""
    try:
        full = _path(path, EXTS)
        with _office(full, readonly=True) as (_, doc):
            proj = _project(doc)
            items = [{"name": c.Name, "type": TYPE_NAMES.get(c.Type, str(c.Type)),
                      "lines": c.CodeModule.CountOfLines}
                     for c in proj.VBComponents]
        return _ok(path=path, modules=items)
    except Exception as e:  # noqa: BLE001
        return _fail(e)


def read_vba(path: str, module: str, start_line: int = 1, max_lines: int = 500) -> str:
    """Прочитать код модуля VBA (имя из list_vba). Строки нумеруются с 1; start_line и max_lines — окно."""
    try:
        full = _path(path, EXTS)
        with _office(full, readonly=True) as (_, doc):
            proj = _project(doc)
            comp = _component(proj, module)
            if comp is None:
                raise ValueError(f"модуль не найден: {module}; есть: {_names(proj)}")
            lines = _code(comp).split("\n") if comp.CodeModule.CountOfLines else []
        s = max(1, int(start_line))
        part = lines[s - 1: s - 1 + max(1, int(max_lines))]
        return _ok(module=module, total_lines=len(lines), start_line=s, code="\n".join(part),
                   truncated=s - 1 + len(part) < len(lines))
    except Exception as e:  # noqa: BLE001
        return _fail(e)


def write_vba(path: str, module: str, code: str, module_type: str = "standard", append: bool = False) -> str:
    """Создать или заменить модуль VBA. Нет файла — создаётся новый .xlsm/.docm.

    module: имя модуля («Module1», «ThisWorkbook», «ThisDocument»). Нет такого — создаётся новый.
    module_type: standard или class (только для нового модуля). append=true — дописать код в конец.
    """
    try:
        if len(code) > MAX_CODE:
            raise ValueError(f"код длиннее {MAX_CODE} знаков")
        if module_type not in TYPES:
            raise ValueError("module_type: standard или class")
        if not module or not module.replace("_", "").isalnum() or module[0].isdigit():
            raise ValueError(f"недопустимое имя модуля: {module}")
        full = _path(path, EXTS)
        existed = os.path.isfile(full)
        with _office(full, create=True) as (_, doc):
            proj = _project(doc)
            comp = _component(proj, module)
            created = comp is None
            if created:
                comp = proj.VBComponents.Add(TYPES[module_type])
                comp.Name = module
            new_code = (_code(comp).rstrip("\n") + "\n" + code) if append and not created else code
            _set_code(comp, new_code)
            lines = comp.CodeModule.CountOfLines
            doc.Save()
        return _ok(path=path, module=module, module_created=created, file_created=not existed, lines=lines)
    except Exception as e:  # noqa: BLE001
        return _fail(e)


def edit_vba(path: str, module: str, replacements: list[dict[str, str]]) -> str:
    """Заменить куски кода в модуле VBA: [{"old": "...", "new": "..."}]. old должен встречаться ровно один раз."""
    try:
        if not replacements:
            raise ValueError("нужны replacements")
        full = _path(path, EXTS)
        with _office(full) as (_, doc):
            proj = _project(doc)
            comp = _component(proj, module)
            if comp is None:
                raise ValueError(f"модуль не найден: {module}; есть: {_names(proj)}")
            code = _code(comp)
            for item in replacements:
                old, new = item.get("old", ""), item.get("new", "")
                if not old:
                    raise ValueError("в replacements пустое old")
                n = code.count(old)
                if n != 1:
                    raise ValueError(f"old найден {n} раз(а), нужно ровно 1: {old[:60]!r}")
                code = code.replace(old, new)
            _set_code(comp, code)
            lines = comp.CodeModule.CountOfLines
            doc.Save()
        return _ok(path=path, module=module, replacements=len(replacements), lines=lines)
    except Exception as e:  # noqa: BLE001
        return _fail(e)


def run_vba(path: str, macro: str, args: list[Any] | None = None, save: bool = False) -> str:
    """Запустить макрос VBA из .xlsm/.docm и вернуть результат (для Function) или ok (для Sub).

    macro: «Main» или «Module1.Main». args: аргументы макроса (числа, строки, логические).
    save=true — сохранить файл после запуска (по умолчанию изменения, сделанные макросом, отбрасываются).
    Макрос выполняется с полными правами пользователя: запускайте только понятный вам код.
    Если макрос показывает диалог (MsgBox, InputBox), он зависнет: в автоматическом запуске их не используйте.
    """
    try:
        if not macro or any(ch in macro for ch in "'\"\r\n"):
            raise ValueError(f"недопустимое имя макроса: {macro!r}")
        full = _path(path, EXTS)
        with _office(full, allow_macros=True) as (app, doc):
            if _is_excel(full):
                target = macro if "!" in macro else f"'{doc.Name}'!{macro}"
            else:
                target = macro
            result = app.Run(target, *(args or []))
            if save:
                doc.Save()
        return _ok(path=path, macro=macro, result=result, saved=bool(save))
    except Exception as e:  # noqa: BLE001
        return _fail(e)


TOOLS = [list_vba, read_vba, write_vba, edit_vba, run_vba]
