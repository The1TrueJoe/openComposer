"""Proof of concept: back up and load Control4 projects in Composer's .c4p format.

A .c4p is a stored (uncompressed) zip:
    project.xml   <currentstate> document, exactly what Director's Upload returns
    drivers/      every .c4i/.c4z the project references
    mm.db, identity.db, images/, announcements/, wallpaper/   optional extras
with backup metadata in the zip comment, CR-separated.

Usage:
    c4project.py inspect FILE.c4p
    c4project.py backup HOST OUT.c4p [--drivers-from DIR_OR_C4P ...]
    c4project.py load HOST FILE.c4p --allow-write HOST

`load` replaces the whole project on HOST, so it refuses unless --allow-write repeats
the same host. Never point it at a live controller you care about.
"""
import argparse
import datetime
import os
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from c4read import Director  # noqa: E402

UPLOAD_FLAGS = 32  # what Composer sends for File > Backup
EXTRA_OPTIONS = ["Personal Information", "Announcements", "Cover Art",
                 "Screen Saver Images", "Custom Wallpaper", "Identity Database"]


def connect(host, allow_write=False):
    return Director(host, os.environ["C4_CERT"], os.environ["C4_KEY"],
                    allow_write=allow_write, timeout=180)


def strip_reply(raw, method):
    """Return the payload inside <c4soap name=method result="1">...</c4soap>."""
    start = raw.index(">") + 1
    if 'result="1"' not in raw[:start]:
        raise RuntimeError(f"{method} failed: {raw[:300]}")
    if raw[:start].endswith("/>"):
        return ""
    return raw[start:raw.rindex("</c4soap>")]


def referenced_drivers(project_xml):
    root = ET.fromstring(project_xml)
    names = {e.text.strip() for e in root.iter("config_data_file") if e.text and e.text.strip()}
    return sorted(names)


def summarize(project_xml):
    root = ET.fromstring(project_xml)
    items = root.find("systemitems")
    return {
        "items": sum(1 for _ in items.iter("item")) if items is not None else 0,
        "bindings": len(root.find("bindings") or []),
        "network bindings": len(root.find("networkbindings") or []),
        "events": sum(1 for _ in root.iter("event")),
        "drivers referenced": len(referenced_drivers(project_xml)),
    }


def driver_sources(paths):
    """Map driver filename -> callable returning bytes, from dirs and/or existing .c4p files."""
    found = {}
    for p in map(Path, paths):
        if p.suffix.lower() == ".c4p":
            z = zipfile.ZipFile(p)
            for n in z.namelist():
                if n.startswith("drivers/") and not n.endswith("/"):
                    found.setdefault(n[len("drivers/"):], lambda z=z, n=n: z.read(n))
        elif p.is_dir():
            for f in p.rglob("*"):
                if f.suffix.lower() in (".c4i", ".c4z"):
                    found.setdefault(f.name, f.read_bytes)
    return found


def cmd_inspect(args):
    z = zipfile.ZipFile(args.file)
    print(z.comment.decode(errors="replace").replace("\r", "\n").strip())
    project = z.read("project.xml").decode("utf-8")
    for k, v in summarize(project).items():
        print(f"{k:20} {v}")
    have = {n[len("drivers/"):] for n in z.namelist() if n.startswith("drivers/") and not n.endswith("/")}
    missing = [d for d in referenced_drivers(project) if d not in have]
    print(f"{'driver files':20} {len(have)} included, {len(missing)} referenced but missing {missing[:5]}")


def cmd_backup(args):
    d = connect(args.host)
    raw, root = d.call("GetVersionInfo")
    director_ver = next((v.get("version") for v in root.iter("version") if v.get("name") == "Director"), "")
    raw, _ = d.call("Upload", flags=UPLOAD_FLAGS)
    project = strip_reply(raw, "Upload")
    name = ET.fromstring(project).findtext("systemitems/item/name") or "Project"

    sources = driver_sources(args.drivers_from)
    wanted = referenced_drivers(project)
    missing = [w for w in wanted if w not in sources]

    now = datetime.datetime.now()
    created = f"{now.month}/{now.day}/{now.year} {now.strftime('%I:%M:%S %p').lstrip('0')}"
    comment = (f"Project Name: {name}\r\rCreated: {created}\rSource: openComposer\r"
               f"Director: {director_ver}\rAuthor: \r\r"
               + "".join(f"{o}: False\r" for o in EXTRA_OPTIONS) + "\r\r")

    with zipfile.ZipFile(args.out, "w", zipfile.ZIP_STORED) as z:
        z.writestr("project.xml", project)
        z.writestr("drivers/", b"")
        for w in wanted:
            if w in sources:
                z.writestr(f"drivers/{w}", sources[w]())
        z.comment = comment.encode()

    for k, v in summarize(project).items():
        print(f"{k:20} {v}")
    print(f"wrote {args.out}: {len(wanted) - len(missing)}/{len(wanted)} driver files included")
    if missing:
        print(f"missing driver files (no source given): {missing}")


def cmd_load(args):
    if args.allow_write != args.host:
        sys.exit(f"refusing to load: pass --allow-write {args.host} to confirm this host may be overwritten")
    z = zipfile.ZipFile(args.file)
    project = z.read("project.xml").decode("utf-8")
    if project.startswith("<?xml"):
        project = project[project.index("?>") + 2:].lstrip()
    expected = summarize(project)

    d = connect(args.host, allow_write=True)
    raw, _ = d.call("Download", _raw_params=f'<param name="project" type="string">{project}</param>')
    strip_reply(raw, "Download")
    raw, _ = d.call("ReloadDatabase")
    strip_reply(raw, "ReloadDatabase")

    # Verify by backing the project straight back up and comparing counts.
    raw, _ = d.call("Upload", flags=UPLOAD_FLAGS)
    actual = summarize(strip_reply(raw, "Upload"))
    for k in expected:
        mark = "ok" if expected[k] == actual[k] else "MISMATCH"
        print(f"{k:20} sent {expected[k]:>5}  now {actual[k]:>5}  {mark}")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("inspect"); p.add_argument("file"); p.set_defaults(fn=cmd_inspect)
    p = sub.add_parser("backup"); p.add_argument("host"); p.add_argument("out")
    p.add_argument("--drivers-from", action="append", default=[]); p.set_defaults(fn=cmd_backup)
    p = sub.add_parser("load"); p.add_argument("host"); p.add_argument("file")
    p.add_argument("--allow-write", default=""); p.set_defaults(fn=cmd_load)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
