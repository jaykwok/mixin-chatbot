"""Real editable Office fixtures and assertions for the document tool integration."""
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
import zipfile
from pathlib import Path
from unittest.mock import patch

from docx import Document
from docx.shared import Inches as WordInches
from PIL import Image, ImageDraw
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.util import Inches, Pt
from pypdf import PdfWriter
from lxml import etree


def check_edit_guards():
    script = Path(__file__).resolve().parents[2] / "src/agent/modules/document-work/scripts/document_ops.py"
    spec = importlib.util.spec_from_file_location("document_ops", script)
    operations = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(operations)
    w, a = operations.NS["w"], operations.NS["a"]
    paragraph = operations.xml(f'<w:p xmlns:w="{w}"><w:r><w:t>外层</w:t></w:r><w:p><w:r><w:t>文本框</w:t></w:r></w:p></w:p>'.encode())
    assert operations.visible_text(paragraph) == "外层"
    operations.replace_text(paragraph, "外层", "修改")
    assert operations.visible_text(paragraph[1]) == "文本框"
    paragraph = operations.xml(f'<a:p xmlns:a="{a}"><a:pPr><a:tabLst><a:tab pos="100"/></a:tabLst></a:pPr><!--comment--><a:r><a:t>名称</a:t></a:r></a:p>'.encode())
    assert operations.visible_text(paragraph) == "名称"
    operations.replace_text(paragraph, "名称", "客户名称")
    assert operations.visible_text(paragraph) == "客户名称"
    paragraph = operations.xml(f'<w:p xmlns:w="{w}"><w:fldSimple w:instr="DATE"><w:r><w:t>日期</w:t></w:r></w:fldSimple></w:p>'.encode())
    try:
        operations.replace_text(paragraph, "日期", "不应替换")
        raise AssertionError("field edits must be rejected")
    except ValueError:
        assert operations.visible_text(paragraph) == "日期"


def add_tag_fixture(path):
    """A non-root slide's metadata reproduces automizer's dangling-tag output."""
    with zipfile.ZipFile(path) as archive:
        data = {n: archive.read(n) for n in archive.namelist()}
    p = "http://schemas.openxmlformats.org/presentationml/2006/main"
    r = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    rel = "http://schemas.openxmlformats.org/package/2006/relationships"
    ct = "http://schemas.openxmlformats.org/package/2006/content-types"
    slide = etree.fromstring(data["ppt/slides/slide1.xml"])
    tags = etree.SubElement(slide.find("{" + p + "}cSld"), "{" + p + "}custDataLst")
    etree.SubElement(tags, "{" + p + "}tags", {"{" + r + "}id": "rIdTrialTag"})
    data["ppt/slides/slide1.xml"] = etree.tostring(slide)
    relationships = etree.fromstring(data["ppt/slides/_rels/slide1.xml.rels"])
    etree.SubElement(relationships, "{" + rel + "}Relationship", Id="rIdTrialTag", Type=r + "/tags", Target="../tags/tag777.xml")
    data["ppt/slides/_rels/slide1.xml.rels"] = etree.tostring(relationships)
    types = etree.fromstring(data["[Content_Types].xml"])
    etree.SubElement(types, "{" + ct + "}Override", PartName="/ppt/tags/tag777.xml", ContentType="application/vnd.openxmlformats-officedocument.presentationml.tags+xml")
    data["[Content_Types].xml"] = etree.tostring(types)
    data["ppt/tags/tag777.xml"] = f'<p:tagLst xmlns:p="{p}"><p:tag name="TRIAL" val="SOURCE-ONLY"/></p:tagLst>'.encode()
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in data.items():
            archive.writestr(name, content)
    # A still-referenced missing tag must never be silently dropped by cleanup.
    broken = path.with_name("broken-referenced-tag.pptx")
    with zipfile.ZipFile(broken, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in data.items():
            if name != "ppt/tags/tag777.xml":
                archive.writestr(name, content)
    spec = importlib.util.spec_from_file_location("document_ops", Path(__file__).resolve().parents[2] / "src/agent/modules/document-work/scripts/document_ops.py")
    operations = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(operations)
    original, _ = operations.package(path, prune_unused_tags=True)
    assert b"rIdTrialTag" in original["ppt/slides/_rels/slide1.xml.rels"]
    try:
        operations.package(broken, prune_unused_tags=True)
        raise AssertionError("referenced missing tag must be rejected")
    except ValueError as error:
        assert "tag777.xml" in str(error)


def check_office_errors(root):
    script = Path(__file__).resolve().parents[2] / "src/agent/modules/document-work/scripts/document_ops.py"
    spec = importlib.util.spec_from_file_location("document_ops", script)
    operations = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(operations)
    source = root / "source.docx"
    for code, diagnostic in ((1, b"Read-only file system: /tmp/OSL_PIPE_fixture"), (0, b"Error: source file could not be loaded")):
        folder = root / f"office-error-{code}"
        folder.mkdir()
        result = subprocess.CompletedProcess([], code, stdout=b"", stderr=diagnostic)
        with patch.object(operations, "office_binary", return_value="fixture-soffice"), patch.object(operations.subprocess, "run", return_value=result) as run:
            try:
                operations.convert_office(source, folder)
                raise AssertionError("conversion failure must be reported")
            except ValueError as error:
                assert diagnostic.decode() in str(error), str(error)
            env = run.call_args.kwargs["env"]
            for key in ("HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "TMPDIR"):
                target = Path(env[key])
                assert target.is_dir() and target.is_relative_to(folder)


def prepare(root):
    check_edit_guards()
    root.mkdir(parents=True, exist_ok=True)
    picture = Image.new("RGB", (480, 240), "#16324F")
    ImageDraw.Draw(picture).rectangle((40, 40, 440, 200), fill="#58C1B2")
    picture.save(root / "product.png")
    document = Document()
    document.add_heading("客户方案", 0)
    p = document.add_paragraph()
    p.add_run("客户").bold = True
    p.add_run("A").italic = True
    p.add_run(" 使用正式产品资料。")
    document.sections[0].header.paragraphs[0].text = "客户 A 内部资料"
    document.add_picture(str(root / "product.png"), width=WordInches(3))
    table = document.add_table(rows=2, cols=2)
    table.style = "Light Shading Accent 1"
    table.cell(0, 0).text, table.cell(0, 1).text = "项目", "内容"
    table.cell(1, 0).text, table.cell(1, 1).text = "部署", "本地部署"
    document.save(root / "source.docx")
    check_office_errors(root)
    supplement = Document()
    supplement.add_heading("实施计划", 1)
    supplement.add_paragraph("准备、实施、验证。")
    supplement.add_picture(str(root / "product.png"), width=WordInches(2))
    supplement.save(root / "supplement.docx")
    for name, labels in [("source.pptx", ["第一页：能力", "第二页：部署", "第三页：实施"]), ("supplement.pptx", ["补充：验证结果"])]:
        prs = Presentation()
        prs.slide_width, prs.slide_height = Inches(13.333333), Inches(7.5)
        color = "F1F6FA" if name == "source.pptx" else "EFF7F0"
        background = etree.fromstring(
            ('<p:bg xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
             'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
             '<p:bgPr><a:solidFill><a:srgbClr val="' + color + '"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>').encode())
        prs.slide_masters[0].element.find("{http://schemas.openxmlformats.org/presentationml/2006/main}cSld").insert(0, background)
        for label in labels:
            slide = prs.slides.add_slide(prs.slide_layouts[5])
            slide.shapes.title.text = label
            frame = slide.shapes.add_textbox(Inches(0.8), Inches(1.5), Inches(5), Inches(1)).text_frame
            p = frame.paragraphs[0]
            run = p.add_run(); run.text = "客户"; run.font.bold = True; run.font.size = Pt(22)
            run = p.add_run(); run.text = "A"; run.font.italic = True; run.font.size = Pt(22)
            slide.shapes.add_picture(str(root / "product.png"), Inches(0.8), Inches(3), width=Inches(4))
            chart = CategoryChartData(); chart.categories = ["准备", "验证"]; chart.add_series("进度", (30, 80))
            slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(6), Inches(2), Inches(6), Inches(4), chart)
            slide.notes_slide.notes_text_frame.text = "测试备注：" + label
        if name == "source.pptx":
            # Logical order differs from slide1.xml/slide2.xml order.
            ids = prs.slides._sldIdLst
            first = ids[0]; ids.remove(first); ids.append(first)
        prs.save(root / name)
    add_tag_fixture(root / "supplement.pptx")
    pdf = PdfWriter()
    for _ in range(22):
        pdf.add_blank_page(width=600, height=400)
    pdf.write(root / "pages.pdf")
    # Run the actual skill examples in the fixed environment, including Chinese fonts.
    project = Path(__file__).resolve().parents[2]
    for guide in ("word", "slides"):
        content = (project / "src/agent/modules/document-work/skills/document-work/references" / (guide + ".md")).read_text(encoding="utf-8")
        code = re.search(r"```python\n(.*?)\n```", content, re.S).group(1)
        script = root / (guide + "-starter.py")
        script.write_text(code, encoding="utf-8")
        subprocess.run([sys.executable, str(script)], env={**os.environ, "PI_USER_TMP": str(root)}, check=True, timeout=30)


def check(root, results):
    patched = Document(results["wordPatch"]["output"])
    p = next(p for p in patched.paragraphs if "客户B" in p.text)
    assert p.runs[0].bold and p.runs[1].italic
    assert len(patched.inline_shapes) == 1
    assert patched.tables[0].cell(1, 1).text == "私有化部署"
    with zipfile.ZipFile(root / "source.docx") as before, zipfile.ZipFile(results["wordPatch"]["output"]) as after:
        for name in before.namelist():
            if name != "word/document.xml":
                assert before.read(name) == after.read(name), name
    merged = Document(results["wordCompose"]["output"])
    assert any(p.text == "实施计划" for p in merged.paragraphs)
    assert len(merged.inline_shapes) == 2
    assert merged.sections[0].header.paragraphs[0].text == "客户 A 内部资料"
    selected = Document(results["wordSelection"]["output"])
    assert len(selected.paragraphs) == 2 and len(selected.tables) == 0
    deck = Presentation(results["pptCompose"]["output"])
    assert any("自定义标签关联" in warning for warning in results["pptCompose"]["warnings"])
    assert [s.shapes.title.text for s in deck.slides] == ["第三页：实施", "第二页：部署", "补充：验证结果", "第三页：实施"]
    with zipfile.ZipFile(results["pptCompose"]["output"]) as archive:
        parts = [n for n in archive.namelist() if n.startswith("ppt/slides/slide") and n.endswith(".xml")]
        assert len(parts) == 4, "unselected slide parts must not remain in the output archive"
        assert all("第一页：能力".encode() not in archive.read(n) for n in parts)
    for slide in deck.slides:
        assert sum(s.shape_type == 13 for s in slide.shapes) == 1
        charts = [s.chart for s in slide.shapes if s.has_chart]
        assert len(charts) == 1 and tuple(charts[0].series[0].values) == (30.0, 80.0)
        assert "测试备注" in slide.notes_slide.notes_text_frame.text
        expected = "EFF7F0" if "补充" in slide.shapes.title.text else "F1F6FA"
        assert str(slide.slide_layout.slide_master.background.fill.fore_color.rgb) == expected
    changed = Presentation(results["pptPatch"]["output"])
    assert any("客户B" in s.text for s in changed.slides[0].shapes if s.has_text_frame)
    with zipfile.ZipFile(results["pptCompose"]["output"]) as before, zipfile.ZipFile(results["pptPatch"]["output"]) as after:
        for name in before.namelist():
            if name != results["pptPatchPart"]:
                assert before.read(name) == after.read(name), name
    assert results["preview"]["pages"] == 22
    assert results["preview"]["unrenderedPages"] == list(range(3, 22))
    assert [i["page"] for i in results["preview"]["images"]] == [22, 1, 2]
    for item in results["preview"]["images"]:
        with Image.open(item["path"]) as picture:
            assert max(picture.size) <= 1800
    for name, stamp in results["sourceDigests"].items():
        assert hashlib.sha256((root / name).read_bytes()).hexdigest() == stamp
    assert Document(root / "客户方案.docx").tables[0].rows[0].cells[0].text == "事项"
    assert len(Presentation(root / "补充页面.pptx").slides) == 1
    for preview in results.get("officePreviews", []):
        assert preview["images"] and not preview["unrenderedPages"]
        assert preview["visuallyReviewed"] is False
    print("DOCUMENT_ARTIFACTS_PASSED")


if __name__ == "__main__":
    mode, directory = sys.argv[1:3]
    if mode == "prepare":
        prepare(Path(directory))
    else:
        check(Path(directory), json.loads(Path(sys.argv[3]).read_text(encoding="utf-8")))
