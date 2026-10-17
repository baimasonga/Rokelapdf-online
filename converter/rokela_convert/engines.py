"""The four conversions. Each takes an input path and writes one output file; nothing else is read or written.

Only permissively licensed libraries are used (pdfplumber/pdfminer.six: MIT, pypdfium2/PDFium: Apache-2.0/BSD,
python-docx, openpyxl, python-pptx: MIT; LibreOffice runs as a separate program). User-facing problems raise
UserError with a message that is safe to show; anything else is an internal error.
"""

from __future__ import annotations

import io
import os
import re
import shutil
import subprocess
from dataclasses import dataclass, field

MAX_PAGES = int(os.environ.get("CONVERTER_MAX_PAGES", "200"))


class UserError(Exception):
    """A problem with the file itself (encrypted, damaged, too many pages). The message is shown to the user."""


# ---- reading PDFs --------------------------------------------------------------------------------------------


_LOCKED = "This PDF is password-protected. Unlock it first, then convert it."
_DAMAGED = "This PDF could not be read. It may be damaged."


def _is_password_error(e: BaseException) -> bool:
    # pdfplumber wraps pdfminer's errors; look through the wrapper.
    seen = [e, *(a for a in e.args if isinstance(a, BaseException))]
    if e.__cause__:
        seen.append(e.__cause__)
    return any("password" in type(x).__name__.lower() or "encrypt" in type(x).__name__.lower() for x in seen)


def _open_pdf(path: str):
    import pdfplumber

    try:
        pdf = pdfplumber.open(path)
        pages = pdf.pages
    except Exception as e:  # pdfminer raises many different exceptions for broken files
        raise UserError(_LOCKED if _is_password_error(e) else _DAMAGED) from None
    if not pages:
        pdf.close()
        raise UserError("This PDF has no pages.")
    if len(pages) > MAX_PAGES:
        pdf.close()
        raise UserError(f"This PDF has {len(pages)} pages. Convert up to {MAX_PAGES} pages at a time (split it first).")
    return pdf


def _open_pdfium(path: str):
    import pypdfium2 as pdfium

    try:
        return pdfium.PdfDocument(path)
    except pdfium.PdfiumError as e:
        raise UserError(_LOCKED if "password" in str(e).lower() else _DAMAGED) from None


_SUBSET = re.compile(r"^[A-Z]{6}\+")


def _font_style(fontname: str) -> tuple[str, bool, bool]:
    """'ABCDEF+Helvetica-BoldOblique' -> ('Helvetica', True, True)."""
    base = _SUBSET.sub("", fontname or "")
    low = base.lower()
    bold = any(k in low for k in ("bold", "black", "heavy", "semibold", "demi"))
    italic = any(k in low for k in ("italic", "oblique"))
    family = re.split(r"[-,]", base)[0] or "Calibri"
    family = re.sub(r"(MT|PS|Std)$", "", family)
    family = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", family) if " " not in family else family
    return family[:60], bold, italic


@dataclass
class Word:
    text: str
    x0: float
    x1: float
    top: float
    bottom: float
    size: float
    family: str
    bold: bool
    italic: bool


@dataclass
class Line:
    words: list[Word] = field(default_factory=list)

    @property
    def x0(self) -> float:
        return min(w.x0 for w in self.words)

    @property
    def x1(self) -> float:
        return max(w.x1 for w in self.words)

    @property
    def top(self) -> float:
        return min(w.top for w in self.words)

    @property
    def bottom(self) -> float:
        return max(w.bottom for w in self.words)

    @property
    def size(self) -> float:
        sizes = sorted(w.size for w in self.words)
        return sizes[len(sizes) // 2]

    @property
    def text(self) -> str:
        return " ".join(w.text for w in self.words)


def _inside(obj, box, slack: float = 1.0) -> bool:
    x0, top, x1, bottom = box
    cx = (obj["x0"] + obj["x1"]) / 2
    cy = (obj["top"] + obj["bottom"]) / 2
    return x0 - slack <= cx <= x1 + slack and top - slack <= cy <= bottom + slack


def _words(page, exclude: list[tuple]) -> list[Word]:
    raw = page.extract_words(extra_attrs=["fontname", "size"], keep_blank_chars=False, use_text_flow=False, x_tolerance=1.5)
    out = []
    for w in raw:
        if any(_inside(w, b) for b in exclude):
            continue
        family, bold, italic = _font_style(w.get("fontname", ""))
        out.append(Word(w["text"], w["x0"], w["x1"], w["top"], w["bottom"], float(w.get("size") or 11), family, bold, italic))
    return out


def _lines(words: list[Word]) -> list[Line]:
    """Groups words into lines by vertical overlap, left to right."""
    lines: list[Line] = []
    for w in sorted(words, key=lambda w: (round(w.top), w.x0)):
        for ln in reversed(lines[-3:]):
            mid = (w.top + w.bottom) / 2
            if ln.top - 1 <= mid <= ln.bottom + 1:
                ln.words.append(w)
                break
        else:
            lines.append(Line([w]))
    for ln in lines:
        ln.words.sort(key=lambda w: w.x0)
    lines.sort(key=lambda ln: ln.top)
    return lines


def _tables(page) -> list:
    try:
        return [t for t in page.find_tables() if len(t.rows) >= 1 and len(t.rows[0].cells) >= 2]
    except Exception:
        return []


def _clean(text: str | None) -> str:
    # Control characters are not allowed in Office XML.
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]", "", text or "")


# ---- PDF -> Word ---------------------------------------------------------------------------------------------


def pdf_to_docx(src: str, dst: str) -> None:
    """Rebuilds a flowing, editable document: paragraphs with their fonts, sizes, bold/italic and alignment,
    tables as real Word tables, and pictures in place. Each PDF page starts a new Word page."""
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
    from docx.shared import Pt

    pdf = _open_pdf(src)
    render = _open_pdfium(src)
    doc = Document()
    try:
        first = pdf.pages[0]
        sec = doc.sections[0]
        sec.page_width, sec.page_height = Pt(float(first.width)), Pt(float(first.height))
        margin = None
        style = doc.styles["Normal"]
        style.paragraph_format.space_after = Pt(0)

        for pi, page in enumerate(pdf.pages):
            width = float(page.width)
            tables = _tables(page)
            tboxes = [t.bbox for t in tables]
            pictures = [im for im in page.images if (im["x1"] - im["x0"]) > 24 and (im["bottom"] - im["top"]) > 24]
            lines = _lines(_words(page, tboxes))
            if margin is None and lines:
                margin = max(18.0, min(90.0, min(ln.x0 for ln in lines)))
                sec.left_margin = sec.right_margin = Pt(margin)
                sec.top_margin = sec.bottom_margin = Pt(min(72.0, max(18.0, lines[0].top)))
            left = margin or 72.0

            # Everything on the page in reading order (top to bottom).
            items: list[tuple[float, str, object]] = [(ln.top, "line", ln) for ln in lines]
            items += [(t.bbox[1], "table", t) for t in tables]
            items += [(im["top"], "image", im) for im in pictures]
            items.sort(key=lambda x: x[0])

            bitmap = None
            para_lines: list[Line] = []

            def flush():
                if not para_lines:
                    return
                p = doc.add_paragraph()
                first_ln = para_lines[0]
                content_w = width - 2 * left
                mid = (min(ln.x0 for ln in para_lines) + max(ln.x1 for ln in para_lines)) / 2
                span = max(ln.x1 for ln in para_lines) - min(ln.x0 for ln in para_lines)
                if abs(mid - width / 2) < 12 and span < content_w * 0.85:
                    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                elif first_ln.x0 - left > 4:
                    p.paragraph_format.left_indent = Pt(max(0.0, min(ln.x0 for ln in para_lines) - left))
                p.paragraph_format.space_after = Pt(max(2.0, first_ln.size * 0.4))
                run_text, run_key = "", None
                for li, ln in enumerate(para_lines):
                    for wi, w in enumerate(ln.words):
                        key = (w.family, round(w.size * 2) / 2, w.bold, w.italic)
                        sep = "" if (li == 0 and wi == 0) else " "
                        if li > 0 and wi == 0 and run_text.endswith("-") and not run_text.endswith(" -"):
                            run_text, sep = run_text[:-1], ""  # re-join a hyphenated word
                        if key != run_key and run_key is not None:
                            _add_run(p, run_text, run_key)
                            run_text = sep
                        else:
                            run_text += sep
                        run_text += w.text
                        run_key = key
                if run_key is not None:
                    _add_run(p, run_text, run_key)
                para_lines.clear()

            for _, kind, obj in items:
                if kind == "line":
                    ln = obj  # type: ignore[assignment]
                    if para_lines:
                        prev = para_lines[-1]
                        gap = ln.top - prev.bottom
                        same_size = abs(ln.size - prev.size) < 1.0
                        same_weight = ln.words[0].bold == prev.words[-1].bold
                        indented = ln.x0 - para_lines[0].x0 > 12 and len(para_lines) > 0
                        short_prev = prev.x1 < (width - left) * 0.8 and prev.text.rstrip()[-1:] in ".:!?"
                        if gap > prev.size * 0.75 or not same_size or not same_weight or indented or short_prev:
                            flush()
                    para_lines.append(ln)
                elif kind == "table":
                    flush()
                    rows = [[_clean(c) for c in (r or [])] for r in obj.extract()]  # type: ignore[union-attr]
                    rows = [r for r in rows if any(c.strip() for c in r)]
                    if rows:
                        ncols = max(len(r) for r in rows)
                        t = doc.add_table(rows=len(rows), cols=ncols)
                        t.style = "Table Grid"
                        for ri, r in enumerate(rows):
                            for ci in range(ncols):
                                t.cell(ri, ci).text = (r[ci] if ci < len(r) else "").replace("\n", " ")
                        doc.add_paragraph()
                else:
                    flush()
                    if bitmap is None:
                        bitmap = render[pi].render(scale=2).to_pil()
                    im = obj  # type: ignore[assignment]
                    k = bitmap.width / width
                    box = (int(im["x0"] * k), int(im["top"] * k), int(im["x1"] * k), int(im["bottom"] * k))
                    box = (max(0, box[0]), max(0, box[1]), min(bitmap.width, box[2]), min(bitmap.height, box[3]))
                    if box[2] - box[0] < 8 or box[3] - box[1] < 8:
                        continue
                    buf = io.BytesIO()
                    bitmap.crop(box).convert("RGB").save(buf, "JPEG", quality=88)
                    buf.seek(0)
                    p = doc.add_paragraph()
                    w_pt = min(float(im["x1"] - im["x0"]), width - 2 * left)
                    p.add_run().add_picture(buf, width=Pt(w_pt))
            flush()
            if pi < len(pdf.pages) - 1:
                doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
            page.flush_cache()
        doc.save(dst)
    finally:
        pdf.close()
        render.close()


def _add_run(p, text: str, key) -> None:
    from docx.shared import Pt

    family, size, bold, italic = key
    r = p.add_run(_clean(text))
    r.font.name = family
    r.font.size = Pt(max(4.0, min(size, 200.0)))
    r.bold = bold or None
    r.italic = italic or None


# ---- PDF -> Excel --------------------------------------------------------------------------------------------

_NUMBER = re.compile(r"^-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$")


def _cell_value(text: str):
    t = text.strip()
    if _NUMBER.match(t):
        n = t.replace(",", "")
        try:
            return int(n) if "." not in n and len(n) < 16 else float(n)
        except ValueError:
            return t
    return t


def _set_cell(ws, row: int, col: int, text: str) -> None:
    v = _cell_value(_clean(text))
    cell = ws.cell(row=row, column=col)
    cell.value = v
    if isinstance(v, str):
        # Text from the PDF is never a formula, even if it starts with "=" (no formula injection).
        cell.data_type = "s"


def _text_rows(page, exclude: list[tuple]) -> list[tuple[float, list[str]]]:
    """Lines of loose text split into columns at wide gaps, so simple column layouts land in separate cells."""
    rows = []
    for ln in _lines(_words(page, exclude)):
        cells, cur, last = [], "", None
        for w in ln.words:
            if last is not None and w.x0 - last > max(12.0, w.size * 1.5):
                cells.append(cur)
                cur = w.text
            else:
                cur = f"{cur} {w.text}" if cur else w.text
            last = w.x1
        cells.append(cur)
        rows.append((ln.top, cells))
    return rows


def pdf_to_xlsx(src: str, dst: str) -> None:
    """One sheet per page. Tables found on the page become rows and columns; text outside tables follows."""
    from openpyxl import Workbook
    from openpyxl.styles import Font
    from openpyxl.utils import get_column_letter

    pdf = _open_pdf(src)
    wb = Workbook()
    wb.remove(wb.active)
    try:
        for pi, page in enumerate(pdf.pages):
            ws = wb.create_sheet(title=f"Page {pi + 1}")
            tables = _tables(page)
            # Tables and the text around them, top to bottom as on the page.
            items: list[tuple[float, list[list[str]], bool]] = [(t.bbox[1], t.extract(), True) for t in tables]
            items += [(top, [cells], False) for top, cells in _text_rows(page, [t.bbox for t in tables])]
            items.sort(key=lambda x: x[0])
            row = 1
            for _, rows, is_table in items:
                if is_table and row > 1:
                    row += 1
                for ri, r in enumerate(rows):
                    for ci, c in enumerate(r or []):
                        _set_cell(ws, row, ci + 1, (c or "").replace("\n", " "))
                        if is_table and ri == 0:
                            ws.cell(row=row, column=ci + 1).font = Font(bold=True)
                    row += 1
                if is_table:
                    row += 1
            for col in ws.columns:
                width = max((len(str(c.value)) for c in col if c.value is not None), default=8)
                ws.column_dimensions[get_column_letter(col[0].column)].width = min(60, max(8, width + 2))
            page.flush_cache()
        wb.save(dst)
    finally:
        pdf.close()


# ---- PDF -> PowerPoint ---------------------------------------------------------------------------------------


def pdf_to_pptx(src: str, dst: str) -> None:
    """One slide per page, each page as a sharp picture filling the slide (layouts stay exactly as they were).
    The page's text goes into the slide notes so it can still be searched and copied."""
    from pptx import Presentation
    from pptx.util import Emu

    _open_pdf(src).close()  # page limit and readable checks
    doc = _open_pdfium(src)
    try:
        pres = Presentation()
        w0, h0 = doc[0].get_size()
        emu = 12700  # EMU per point
        # PowerPoint allows slides between 1 and 56 inches per side.
        k = min(1.0, (56 * 72) / max(w0, h0))
        if min(w0, h0) * k < 72:
            k = 72 / min(w0, h0)
        pres.slide_width, pres.slide_height = Emu(int(w0 * k * emu)), Emu(int(h0 * k * emu))
        blank = pres.slide_layouts[6]
        for i in range(len(doc)):
            page = doc[i]
            w, h = page.get_size()
            scale = min(2.0, 2400 / max(w, h))
            img = page.render(scale=scale).to_pil().convert("RGB")
            buf = io.BytesIO()
            img.save(buf, "JPEG", quality=88)
            buf.seek(0)
            slide = pres.slides.add_slide(blank)
            sw, sh = pres.slide_width, pres.slide_height
            fit = min(sw / (w * emu), sh / (h * emu))
            pw, ph = int(w * emu * fit), int(h * emu * fit)
            slide.shapes.add_picture(buf, Emu((sw - pw) // 2), Emu((sh - ph) // 2), Emu(pw), Emu(ph))
            text = _clean(page.get_textpage().get_text_range().replace("\r\n", "\n").replace("\r", "\n"))
            if text.strip():
                slide.notes_slide.notes_text_frame.text = text[:20000]
        pres.save(dst)
    finally:
        doc.close()


# ---- Word / Excel / PowerPoint -> PDF ------------------------------------------------------------------------

# Hardened LibreOffice profile: no macros, no updating of linked content, no loading of untrusted remote links.
_PROFILE = """<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>1</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="UseLocking" oor:op="fuse"><value>false</value></prop></item>
</oor:items>
"""

OFFICE_EXTS = {"docx", "doc", "odt", "rtf", "xlsx", "xls", "ods", "pptx", "ppt", "odp"}


def office_to_pdf(src: str, dst: str, ext: str, timeout: float) -> None:
    if ext not in OFFICE_EXTS:
        raise UserError("This file type cannot be converted.")
    src = os.path.abspath(src)
    work = os.path.dirname(src)
    profile = os.path.join(work, "profile")
    os.makedirs(os.path.join(profile, "user"), exist_ok=True)
    with open(os.path.join(profile, "user", "registrymodifications.xcu"), "w", encoding="utf-8") as f:
        f.write(_PROFILE)
    named = os.path.join(work, f"document.{ext}")
    os.replace(src, named)
    outdir = os.path.join(work, "out")
    os.makedirs(outdir, exist_ok=True)
    soffice = shutil.which("soffice") or "soffice"
    cmd = [
        soffice,
        f"-env:UserInstallation=file://{profile}",
        "--headless",
        "--invisible",
        "--nologo",
        "--norestore",
        "--nolockcheck",
        "--nodefault",
        "--convert-to",
        "pdf",
        "--outdir",
        outdir,
        named,
    ]
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": work, "LANG": "C.UTF-8", "SAL_USE_VCLPLUGIN": "svp"}
    r = subprocess.run(cmd, cwd=work, env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout)
    out = os.path.join(outdir, "document.pdf")
    if r.returncode != 0 or not os.path.exists(out) or os.path.getsize(out) == 0:
        raise UserError("This file could not be converted. It may be damaged or password-protected.")
    os.replace(out, dst)
