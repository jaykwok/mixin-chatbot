"""Offline parser smoke test. Outputs remain under agents/temp for inspection."""
from pathlib import Path
from tempfile import mkdtemp
import json
import pandas as pd
from docx import Document
from openpyxl import Workbook, load_workbook
from PIL import Image
from pptx import Presentation
from pypdf import PdfReader, PdfWriter

temporary = Path("agents/temp")
temporary.mkdir(parents=True, exist_ok=True)
root = Path(mkdtemp(prefix="document-check-", dir=temporary))
text = "量子产品资料回归"
document = Document()
document.add_paragraph(text)
document.save(root / "sample.docx")
assert Document(root / "sample.docx").paragraphs[0].text == text
presentation = Presentation()
presentation.slides.add_slide(presentation.slide_layouts[0]).shapes.title.text = text
presentation.save(root / "sample.pptx")
assert Presentation(root / "sample.pptx").slides[0].shapes.title.text == text
book = Workbook()
book.active["A1"] = text
book.save(root / "sample.xlsx")
assert load_workbook(root / "sample.xlsx").active["A1"].value == text
pd.DataFrame({"资料": [text]}).to_excel(root / "dataframe.xlsx", engine="xlsxwriter", index=False)
assert pd.read_excel(root / "dataframe.xlsx").iloc[0, 0] == text
pdf = PdfWriter()
pdf.add_blank_page(width=72, height=72)
with (root / "sample.pdf").open("wb") as handle:
    pdf.write(handle)
assert len(PdfReader(root / "sample.pdf").pages) == 1
Image.new("RGB", (16, 16), "white").save(root / "sample.png")
with Image.open(root / "sample.png") as image:
    assert image.size == (16, 16)
result = {"formats": ["docx", "pptx", "xlsx", "pdf", "png"], "status": "passed"}
(root / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({**result, "directory": str(root)}, ensure_ascii=False))
