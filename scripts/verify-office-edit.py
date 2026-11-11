"""Compare immutable OOXML versions before publishing a scoped edit."""

import argparse
import json
from pathlib import Path, PurePosixPath
import posixpath
import re
import sys
from xml.etree import ElementTree
from xml.parsers import expat
from zipfile import BadZipFile, ZIP_DEFLATED, ZIP_STORED, ZipFile


MAX_PACKAGE_BYTES = 32 * 1024 * 1024
MAX_EXPANDED_BYTES = 64 * 1024 * 1024
MAX_PART_BYTES = 16 * 1024 * 1024
MAX_PARTS = 2048
PRESENTATION = "http://schemas.openxmlformats.org/presentationml/2006/main"
WORKBOOK = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
PACKAGE_CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types"
REL_ID = f"{{{OFFICE_REL}}}id"
CELL = re.compile(r"([A-Z]{1,3})([1-9][0-9]{0,6})\Z")


def safe_xml(data):
    # Office XML is UTF-8. Reject all declarations that can define entities.
    text = data.decode("utf-8-sig", errors="strict")
    if "\x00" in text or re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b", text, re.I):
        raise ValueError("Unsupported Office XML declaration")
    return ElementTree.fromstring(text)


def xml(data, root_tag):
    root = safe_xml(data)
    if root.tag != root_tag:
        raise ValueError("Unexpected Office XML root")
    return root


def read_package(stream, allow_directories=False):
    stream.seek(0, 2)
    if stream.tell() > MAX_PACKAGE_BYTES:
        raise ValueError("Office package exceeds the size limit")
    stream.seek(0)
    if stream.read(4) != b"PK\x03\x04":
        raise ValueError("Expected an Office ZIP package")
    with ZipFile(stream) as archive:
        entries = archive.infolist()
        if archive.comment or len(entries) > MAX_PARTS or sum(i.file_size for i in entries) > MAX_EXPANDED_BYTES:
            raise ValueError("Unsupported Office archive")
        parts = {}
        for info in entries:
            name = info.filename
            if allow_directories and info.is_dir() and not info.file_size and re.fullmatch(r"(?:[A-Za-z0-9_-]+/)+", name):
                continue
            if (
                info.orig_filename != name or not re.fullmatch(r"[A-Za-z0-9_./\[\]-]+", name)
                or any(piece in ("", ".", "..") for piece in name.split("/"))
                or info.flag_bits & 1 or info.compress_type not in (ZIP_STORED, ZIP_DEFLATED)
                or info.file_size > MAX_PART_BYTES or name in parts
            ):
                raise ValueError("Unsupported Office archive entry")
            parts[name] = archive.read(info)
        if "[Content_Types].xml" not in parts or len({name.lower() for name in parts}) != len(parts):
            raise ValueError("Missing or ambiguous Office package parts")
        return parts


def editable_parts(parts, file_format):
    if file_format == "pptx":
        folder, filename, namespace = "ppt", "presentation.xml", PRESENTATION
        root, collection, tag, kind = "presentation", "sldIdLst", "sldId", "slide"
        target_pattern = r"slides/slide[1-9][0-9]*\.xml"
    elif file_format == "xlsx":
        folder, filename, namespace = "xl", "workbook.xml", WORKBOOK
        root, collection, tag, kind = "workbook", "sheets", "sheet", "worksheet"
        target_pattern = r"worksheets/sheet[1-9][0-9]*\.xml"
    else:
        raise ValueError("Scoped edits support .pptx and .xlsx only")
    document = xml(parts[f"{folder}/{filename}"], f"{{{namespace}}}{root}")
    relations = xml(parts[f"{folder}/_rels/{filename}.rels"], f"{{{PACKAGE_REL}}}Relationships")
    relationship_ids = [entry.attrib["Id"] for entry in relations]
    if len(relationship_ids) != len(set(relationship_ids)):
        raise ValueError("Ambiguous Office relationship")
    targets = {
        entry.attrib["Id"]: entry.attrib["Target"]
        for entry in relations
        if entry.tag == f"{{{PACKAGE_REL}}}Relationship"
        and entry.attrib.get("TargetMode", "Internal") == "Internal"
        and entry.attrib.get("Type") == f"{OFFICE_REL}/{kind}"
    }
    items = document.findall(f"{{{namespace}}}{collection}/{{{namespace}}}{tag}")
    if not items:
        raise ValueError("Office package has no supported editable parts")
    names = {}
    for number, item in enumerate(items, start=1):
        target = targets[item.attrib[REL_ID]]
        if target.startswith(f"/{folder}/"):
            target = target[len(folder) + 2:]
        if not re.fullmatch(target_pattern, target):
            raise ValueError("Unsupported Office part relationship")
        path = str(PurePosixPath(folder, target))
        name = str(number) if file_format == "pptx" else item.attrib["name"]
        if name in names or path in names.values() or path not in parts:
            raise ValueError("Missing or ambiguous Office part")
        names[name] = path
    return names


def cell_position(reference):
    match = CELL.fullmatch(reference)
    if not match:
        raise ValueError("Invalid Excel cell reference")
    column = 0
    for character in match.group(1):
        column = column * 26 + ord(character) - ord("A") + 1
    row = int(match.group(2))
    if column > 16384 or row > 1048576:
        raise ValueError("Excel cell reference exceeds sheet bounds")
    return column, row


def cell_range(reference):
    first, separator, last = reference.partition(":")
    left, top = cell_position(first)
    right, bottom = cell_position(last if separator else first)
    if left > right or top > bottom:
        raise ValueError("Invalid Excel range")
    return left, top, right, bottom


def sheet_without_ranges(data, ranges):
    xml(data, f"{{{WORKBOOK}}}worksheet")
    parser = expat.ParserCreate(namespace_separator=" ")
    cell_path = [f"{WORKBOOK} {name}" for name in ("worksheet", "sheetData", "row", "c")]
    elements = []
    rows = set()
    seen = set()
    omissions = []
    current_row = None
    cell_start = None
    sheet_data_count = 0

    def start(name, attributes):
        nonlocal current_row, cell_start, sheet_data_count
        elements.append(name)
        if elements == cell_path[:2]:
            sheet_data_count += 1
        elif elements[:2] == cell_path[:2] and len(elements) in (3, 4):
            if elements == cell_path[:3]:
                current_row = attributes.get("r")
                if not current_row or current_row in rows:
                    raise ValueError("Ambiguous worksheet row")
                rows.add(current_row)
            elif elements == cell_path:
                column, index = cell_position(attributes["r"])
                if str(index) != current_row or (column, index) in seen:
                    raise ValueError("Ambiguous worksheet cell")
                seen.add((column, index))
                if any(left <= column <= right and top <= index <= bottom for left, top, right, bottom in ranges):
                    cell_start = parser.CurrentByteIndex
            else:
                raise ValueError("Unexpected worksheet cell data")

    def end(_name):
        nonlocal cell_start
        if elements == cell_path and cell_start is not None:
            position = parser.CurrentByteIndex
            closing = re.match(rb"</(?:[^\s:>]+:)?c\s*>", data[position:position + 256])
            if closing:
                position += len(closing.group())
            elif data[position - 2:position] != b"/>":
                raise ValueError("Unsupported worksheet cell boundary")
            omissions.append((cell_start, position))
            cell_start = None
        elements.pop()

    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.Parse(data, True)
    if sheet_data_count != 1:
        raise ValueError("Worksheet must have one cell-data element")
    # Preserve every byte outside the selected cells, including namespace declarations and row metadata.
    remaining = []
    previous = 0
    for start, end in omissions:
        remaining.append(data[previous:start])
        previous = end
    remaining.append(data[previous:])
    return b"".join(remaining)


def verify_edit(previous, candidate, file_format, grants):
    original, saved = read_package(previous), read_package(candidate)
    if original.keys() != saved.keys():
        raise ValueError("The saved file adds or removes package parts")
    by_name = editable_parts(original, file_format)
    allowed = {}
    for grant in grants:
        if file_format == "pptx":
            name, ranges = grant, None
        else:
            name, separator, reference = grant.rpartition("!")
            ranges = [cell_range(reference)] if separator else None
            if not separator:
                name = grant
        path = by_name.get(name)
        if not path:
            raise ValueError(f"Unknown granted part: {name}")
        if path not in allowed or ranges is None:
            allowed[path] = ranges
        elif allowed[path] is not None:
            allowed[path].extend(ranges)
    root_tag = f"{{{PRESENTATION}}}sld" if file_format == "pptx" else f"{{{WORKBOOK}}}worksheet"
    changed = set()
    for path, old in original.items():
        new = saved[path]
        if old == new:
            continue
        if path not in allowed:
            raise ValueError(f"Edit outside the granted parts: {path}")
        ranges = allowed[path]
        if ranges is None:
            xml(old, root_tag)
            xml(new, root_tag)
        elif sheet_without_ranges(old, ranges) != sheet_without_ranges(new, ranges):
            raise ValueError(f"Edit outside the granted cells: {path}")
        changed.add(path)
    return [name for name, path in by_name.items() if path in changed]


def office_comments(stream):
    parts = read_package(stream, allow_directories=True)
    manifest = xml(parts["[Content_Types].xml"], f"{{{PACKAGE_CONTENT_TYPES}}}Types")
    main_types = {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
    }
    overrides = {}
    defaults = {}
    for entry in manifest:
        content_type = entry.attrib["ContentType"].lower()
        if entry.tag == f"{{{PACKAGE_CONTENT_TYPES}}}Override":
            name = entry.attrib["PartName"].removeprefix("/")
            if name not in parts or name in overrides:
                raise ValueError("Missing or ambiguous Office content type")
            overrides[name] = content_type
        elif entry.tag == f"{{{PACKAGE_CONTENT_TYPES}}}Default":
            extension = entry.attrib["Extension"].lower()
            if extension in defaults:
                raise ValueError("Ambiguous Office content type")
            defaults[extension] = content_type
        else:
            raise ValueError("Unknown Office content type declaration")
    if not main_types.intersection(overrides.values()):
        raise ValueError("Only DOCX, XLSX and PPTX Office packages can be screened")
    if any("/embeddings/" in name.lower() for name in parts):
        raise ValueError("Embedded Office packages cannot be screened")
    comment_parts = {
        name for name in parts if "comment" in overrides.get(name, defaults.get(name.rsplit(".", 1)[-1].lower(), ""))
        or re.search(r"(?:^|/)(?:comments?|threadedcomments?|comments?extended)(?:/|[0-9.]|$)", name, re.I)
    }
    for name, data in parts.items():
        if not name.endswith(".rels"):
            continue
        relations = xml(data, f"{{{PACKAGE_REL}}}Relationships")
        folder = name.rsplit("/", 2)[0] if name.count("/") >= 2 else ""
        for entry in relations:
            kind = entry.attrib["Type"].lower()
            if kind.endswith(("/package", "/oleobject")):
                raise ValueError("Embedded Office packages cannot be screened")
            if "comment" not in kind:
                continue
            target = entry.attrib["Target"]
            resolved = posixpath.normpath(target[1:] if target.startswith("/") else posixpath.join(folder, target))
            if entry.attrib.get("TargetMode", "Internal") != "Internal" or resolved not in parts:
                raise ValueError("Unresolved Office comment relationship")
            comment_parts.add(resolved)
    comments = []
    byte_count = 0
    for name in sorted(comment_parts):
        root = safe_xml(parts[name])
        if any(node.tag.rsplit("}", 1)[-1].lower() in {"altchunk", "object", "subdoc"} for node in root.iter()):
            raise ValueError("Embedded comment content cannot be screened")
        items = [node for node in root.iter() if node.tag.rsplit("}", 1)[-1].lower() in {"comment", "cm", "threadedcomment"}]
        for node in items or [root]:
            # Joining XML runs exposes phrases split across bold, mention, or other formatting.
            text = "".join(node.itertext()).strip()
            if text:
                comments.append(text)
                byte_count += len(text.encode("utf-8"))
                if byte_count > 60_000 or len(comments) > 1024:
                    raise ValueError("Office comments exceed the private screening size limit")
    return comments


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("format", choices=("pptx", "xlsx", "comments"))
    parser.add_argument("previous")
    parser.add_argument("candidate", nargs="?")
    parser.add_argument("--part", action="append",
                        help="One-based slide position, Excel sheet name, or Sheet!A1:B5")
    arguments = parser.parse_args()
    try:
        with Path(arguments.previous).open("rb") as previous:
            if arguments.format == "comments":
                print(json.dumps({"comments": office_comments(previous)}))
            else:
                if not arguments.candidate or not arguments.part:
                    parser.error("Scoped edits need a candidate file and at least one granted part")
                with Path(arguments.candidate).open("rb") as candidate:
                    changed = verify_edit(previous, candidate, arguments.format, arguments.part)
                print(json.dumps({"changedParts": changed}))
    except (OSError, ValueError, BadZipFile, ElementTree.ParseError, expat.ExpatError, KeyError, NotImplementedError, RuntimeError) as error:
        print(f"Office edit rejected: {error}", file=sys.stderr)
        sys.exit(1)
