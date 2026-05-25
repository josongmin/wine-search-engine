#!/usr/bin/env python3
"""Replace raw retrieval channel string literals with RETRIEVAL_CHANNEL_* constants in src/."""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SSOT = ROOT / "src/domain/retrieval/model/retrieval-channel.ts"

REPLACEMENTS: list[tuple[str, str]] = [
    ("'compare_anchor'", "RETRIEVAL_CHANNEL_COMPARE_ANCHOR"),
    ("'browse_region'", "RETRIEVAL_CHANNEL_BROWSE_REGION"),
    ("'browse_producer'", "RETRIEVAL_CHANNEL_BROWSE_PRODUCER"),
    ("'anchor_similarity'", "RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY"),
    ("'relative_filter'", "RETRIEVAL_CHANNEL_RELATIVE_FILTER"),
    ("'learned_sparse'", "RETRIEVAL_CHANNEL_LEARNED_SPARSE"),
    ("'dense_semantic'", "RETRIEVAL_CHANNEL_DENSE_SEMANTIC"),
    ("'sparse_bm25'", "RETRIEVAL_CHANNEL_SPARSE_BM25"),
]

CONST_NAMES = {c for _, c in REPLACEMENTS}


def rel_import_path(from_file: Path) -> str:
    import os

    rel_str = os.path.relpath(SSOT.with_suffix(".js"), from_file.parent).replace("\\", "/")
    if not rel_str.startswith("."):
        rel_str = "./" + rel_str
    return rel_str


def apply_file(path: Path) -> bool:
    skip = {
        SSOT,
        ROOT / "src/domain/retrieval/model/provenance.ts",
    }
    if path in skip or "__tests__" in path.parts or path.name.endswith(".test.ts"):
        return False
    text = path.read_text(encoding="utf-8")
    used: set[str] = set()
    out = text
    for old, const in REPLACEMENTS:
        if old in out:
            used.add(const)
            out = out.replace(old, const)
    if not used:
        return False

    import_names = sorted(used)
    import_block = (
        "import {\n  "
        + ",\n  ".join(import_names)
        + f"\n}} from '{rel_import_path(path)}';\n"
    )

    if "RETRIEVAL_CHANNEL_SPARSE_BM25" in out and "from '" in out and "retrieval-channel" in out:
        # merge into existing import from retrieval-channel
        m = re.search(
            r"import \{([^}]+)\} from ['\"]([^'\"]*retrieval-channel\.js)['\"];",
            out,
            re.DOTALL,
        )
        if m:
            existing = {x.strip() for x in m.group(1).split(",") if x.strip()}
            merged = sorted(existing | used)
            new_import = (
                "import {\n  "
                + ",\n  ".join(merged)
                + f"\n}} from '{m.group(2)}';\n"
            )
            out = out[: m.start()] + new_import + out[m.end() :]
        else:
            out = import_block + out
    else:
        # insert after last import
        lines = out.splitlines(keepends=True)
        last_import = 0
        for i, line in enumerate(lines):
            if line.startswith("import "):
                last_import = i + 1
        lines.insert(last_import, import_block)
        out = "".join(lines)

    path.write_text(out, encoding="utf-8")
    return True


def main() -> None:
    changed = 0
    for path in sorted((ROOT / "src").rglob("*.ts")):
        if apply_file(path):
            print(f"updated {path.relative_to(ROOT)}")
            changed += 1
    print(f"OK: {changed} files")


if __name__ == "__main__":
    main()
