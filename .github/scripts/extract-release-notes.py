#!/usr/bin/env python3
"""Extract the highlight section for <version> from CHANGELOG.md.

Usage:
    python3 extract-release-notes.py <version> <changelog.md>

Like `awk`-style section slicing: prints everything after the version's
"## " heading up to the next "## " heading (or EOF), trimmed.
Exits 0 with empty output when the section is missing; the caller workflow
fails fast on empty output so a forgotten CHANGELOG entry cannot slip out.
"""
import re
import sys

# 强制 UTF-8 输出：CI（Linux）默认即 UTF-8，此兜底只为 Windows 本地验证时
# 不被 GBK 控制台编码挡住（emoji 亮点会触发 UnicodeEncodeError）。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

HEADING = re.compile(r"^##\s+\[?(v?\d+(?:\.\d+)*)\]?", re.M)


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: extract-release-notes.py <version> <changelog.md>", file=sys.stderr)
        return 2
    version = sys.argv[1].lstrip("v")
    path = sys.argv[2]
    text = open(path, encoding="utf-8").read()

    # Collect all version headings with their byte offsets.
    headings = [(m.group(1).lstrip("v"), m.start()) for m in HEADING.finditer(text)]

    start = end = None
    for i, (ver, pos) in enumerate(headings):
        if ver == version:
            start = pos
            end = headings[i + 1][1] if i + 1 < len(headings) else len(text)
            break

    if start is None:
        return 0  # section not found -> empty output

    body = text[start:end]
    nl = body.find("\n")
    if nl != -1:
        body = body[nl + 1 :]
    sys.stdout.write(body.strip() + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())