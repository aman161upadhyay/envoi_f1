from io import BytesIO
import runpy
from pathlib import Path
import unittest
from zipfile import ZIP_DEFLATED, ZipFile


OFFICE = runpy.run_path(str(Path(__file__).resolve().parent.parent / "scripts" / "verify-office-edit.py"))
verify_edit = OFFICE["verify_edit"]
PRESENTATION = OFFICE["PRESENTATION"]
WORKBOOK = OFFICE["WORKBOOK"]
OFFICE_REL = OFFICE["OFFICE_REL"]
PACKAGE_REL = OFFICE["PACKAGE_REL"]


def relationships(*relationships):
    body = "".join(
        f'<Relationship Id="{rel_id}" Type="{OFFICE_REL}/{kind}" Target="{target}"/>'
        for rel_id, kind, target in relationships
    )
    return f'<Relationships xmlns="{PACKAGE_REL}">{body}</Relationships>'


class OfficeEditScopeTest(unittest.TestCase):
    def verify(self, file_format, previous, changed, grants):
        baseline, candidate = BytesIO(), BytesIO()
        for stream, parts in ((baseline, previous), (candidate, previous | changed)):
            with ZipFile(stream, "w", compression=ZIP_DEFLATED) as archive:
                archive.writestr("[Content_Types].xml", "<Types/>")
                for path, value in parts.items():
                    archive.writestr(path, value)
        return verify_edit(baseline, candidate, file_format, grants)

    def test_slide_positions_follow_presentation_order_and_lock_other_parts(self):
        presentation = {
            "ppt/presentation.xml": f'<presentation xmlns="{PRESENTATION}" xmlns:r="{OFFICE_REL}">'
                                    '<sldIdLst><sldId r:id="r2"/><sldId r:id="r1"/></sldIdLst></presentation>',
            "ppt/_rels/presentation.xml.rels": relationships(("r1", "slide", "slides/slide1.xml"),
                                                            ("r2", "slide", "slides/slide2.xml")),
            "ppt/slides/slide1.xml": f'<sld xmlns="{PRESENTATION}"><cSld name="Second"/></sld>',
            "ppt/slides/slide2.xml": f'<sld xmlns="{PRESENTATION}"><cSld name="First"/></sld>',
            "ppt/slideLayouts/slideLayout1.xml": "locked layout",
        }
        edited = f'<sld xmlns="{PRESENTATION}"><cSld name="Edited"/></sld>'
        self.assertEqual(self.verify("pptx", presentation, {"ppt/slides/slide2.xml": edited}, ["1"]), ["1"])
        with self.assertRaisesRegex(ValueError, "outside the granted parts"):
            self.verify("pptx", presentation, {"ppt/slides/slide1.xml": edited}, ["1"])
        with self.assertRaisesRegex(ValueError, "outside the granted parts"):
            self.verify("pptx", presentation, {"ppt/slideLayouts/slideLayout1.xml": "different"}, ["1"])
        with self.assertRaisesRegex(ValueError, "adds or removes package parts"):
            self.verify("pptx", presentation, {"ppt/slides/slide3.xml": edited}, ["1"])

    def test_workbook_range_keeps_other_cells_and_sheet_metadata_unchanged(self):
        sheet = f'<worksheet xmlns="{WORKBOOK}"><sheetData><row r="1">' \
                '<c r="A1"><v>1</v></c><c r="B1"><v>2</v></c><c r="C1"/>' \
                '</row></sheetData></worksheet>'
        workbook = {
            "xl/workbook.xml": f'<workbook xmlns="{WORKBOOK}" xmlns:r="{OFFICE_REL}">'
                               '<sheets><sheet name="Costs" r:id="r1"/></sheets></workbook>',
            "xl/_rels/workbook.xml.rels": relationships(("r1", "worksheet", "worksheets/sheet3.xml")),
            "xl/worksheets/sheet3.xml": sheet,
        }
        changed = {"xl/worksheets/sheet3.xml": sheet.replace("<v>1</v>", "<v>3</v>").replace('<c r="C1"/>', '<c r="C1"><v>4</v></c>')}
        self.assertEqual(self.verify("xlsx", workbook, changed, ["Costs!A1", "Costs!C1"]), ["Costs"])
        with self.assertRaisesRegex(ValueError, "outside the granted cells"):
            self.verify("xlsx", workbook, changed, ["Costs!A1"])
        metadata = {"xl/worksheets/sheet3.xml": sheet.replace('<row r="1">', '<row r="1" hidden="1">')}
        with self.assertRaisesRegex(ValueError, "outside the granted cells"):
            self.verify("xlsx", workbook, metadata, ["Costs!A1:C1"])
        duplicates = {"xl/worksheets/sheet3.xml": sheet.replace('r="B1"', 'r="A1"')}
        with self.assertRaisesRegex(ValueError, "Ambiguous worksheet cell"):
            self.verify("xlsx", workbook, duplicates, ["Costs!A1:C1"])
        with self.assertRaisesRegex(ValueError, "Unsupported Office XML declaration"):
            self.verify("xlsx", workbook, {"xl/worksheets/sheet3.xml": "<!DOCTYPE worksheet>" + sheet}, ["Costs!A1"])
        with self.assertRaisesRegex(ValueError, "Unsupported Office archive entry"):
            self.verify("xlsx", workbook, {"../escape.xml": "<escape/>"}, ["Costs!A1"])


if __name__ == "__main__":
    unittest.main()
