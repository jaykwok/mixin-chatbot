"""Office program discovery with synthetic files; never launches installed software."""
import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


def check(operations, root):
    root.mkdir(parents=True, exist_ok=True)
    custom = root / "Office files" / "soffice.exe"
    custom.parent.mkdir()
    custom.write_text("fixture", encoding="utf-8")
    path_program = root / "path-soffice"
    path_program.write_text("fixture", encoding="utf-8")
    with patch.object(operations.shutil, "which", return_value=str(path_program)) as which:
        assert operations.office_binary(str(custom)) == str(custom)
        which.assert_not_called()
        for invalid in (str(root / "missing.exe"), str(custom.parent), "relative/soffice"):
            try:
                operations.office_binary(invalid)
                raise AssertionError("invalid explicit path must fail instead of using PATH")
            except ValueError as error:
                assert invalid in str(error)
        which.assert_not_called()
    with patch.object(operations, "os", SimpleNamespace(name="posix", environ={})), \
            patch.object(operations.shutil, "which", side_effect=lambda name: str(path_program) if name == "soffice" else None):
        assert operations.office_binary() == str(path_program)
    with patch.object(operations, "os", SimpleNamespace(name="posix", environ={})), \
            patch.object(operations.shutil, "which", side_effect=lambda name: str(path_program) if name == "libreoffice" else None):
        assert operations.office_binary("") == str(path_program)
    for key in ("ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"):
        install = root / key / "LibreOffice/program/soffice.exe"
        install.parent.mkdir(parents=True)
        install.write_text("fixture", encoding="utf-8")
        with patch.object(operations, "os", SimpleNamespace(name="nt", environ={key: str(root / key)})), \
                patch.object(operations.shutil, "which", return_value=None):
            assert operations.office_binary() == str(install)
        with patch.object(operations, "os", SimpleNamespace(name="nt", environ={key: str(root / key)})), \
                patch.object(operations.shutil, "which", return_value=str(path_program)):
            assert operations.office_binary() == str(path_program)
    with patch.object(operations, "os", SimpleNamespace(name="posix", environ={})), \
            patch.object(operations.shutil, "which", return_value=None):
        assert operations.office_binary() is None


if __name__ == "__main__":
    spec = importlib.util.spec_from_file_location("document_ops", Path(__file__).resolve().parents[2] / "src/agent/modules/document-work/scripts/document_ops.py")
    operations = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(operations)
    check(operations, Path(sys.argv[1]))
    print("DOCUMENT_OFFICE_PATH_PASSED")
