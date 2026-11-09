"""Render the public legal pages using private operator details."""
import argparse
from html import escape
import json
from pathlib import Path
import re

TEMPLATES = Path(__file__).resolve().parents[1] / "deploy" / "legal"
MARKER = re.compile(r"\{\{([a-z_]+)\}\}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operator_details", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    details = json.loads(args.operator_details.read_text(encoding="utf-8-sig"))
    rendered = {}
    for name in ("terms.html", "privacy.html"):
        template = (TEMPLATES / name).read_text(encoding="utf-8")
        keys = set(MARKER.findall(template))
        if any(not isinstance(details.get(key), str) or not details[key].strip() for key in keys):
            parser.error(f"Missing operator details for {name}")
        rendered[name] = MARKER.sub(lambda match: escape(details[match[1]]), template)
    args.output.mkdir(parents=True, exist_ok=True)
    for name, content in rendered.items():
        (args.output / name).write_text(content, encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
