"""Prepare public frontend files for /opt/wep_pril/frontend; never deploy."""
import argparse
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_EXTENSIONS = {".html", ".css", ".js", ".png", ".jpg", ".jpeg", ".webp",
                     ".gif", ".svg", ".ico", ".woff", ".woff2", ".ttf"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    source = ROOT / "Фронт"
    files = sorted(path for path in source.rglob("*") if path.is_file()
                   and path.suffix.lower() in PUBLIC_EXTENSIONS
                   and not path.is_symlink()
                   and (path.parent == source or path.relative_to(source).parts[0] == "assets")
                   and not any(part.startswith(".") for part in path.relative_to(source).parts))
    if source / "index.html" not in files:
        raise SystemExit("Missing index.html")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.output, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            archive.write(path, path.relative_to(source).as_posix())
    with zipfile.ZipFile(args.output) as archive:
        if archive.testzip() is not None:
            raise SystemExit("Archive integrity check failed")
    print(f"Prepared {len(files)} public files: {args.output.resolve()}")


if __name__ == "__main__":
    main()
