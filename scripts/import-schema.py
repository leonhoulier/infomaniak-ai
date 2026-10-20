#!/usr/bin/env python3
"""Fetch selected public operation schemas. This never admits them to execution."""
import argparse
import json
from pathlib import Path
from urllib.parse import quote
from importlib.util import spec_from_file_location, module_from_spec

ROOT = Path(__file__).resolve().parents[1]
spec = spec_from_file_location("catalogue", ROOT / "scripts/sync-catalogue.py")
module = module_from_spec(spec)
spec.loader.exec_module(module)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("method")
parser.add_argument("path")
args = parser.parse_args()
method = args.method.upper()
rows = json.loads((ROOT / "data/catalogue.json").read_text())["operations"]
entry = next((r for r in rows if r["method"] == method and r["path"] == args.path), None)
if not entry:
    raise SystemExit("Operation is absent from the public catalogue")
page = module.fetch_page(entry["documentation"])
operation = page["props"]["operation"]
if operation["method"].upper() != method or operation["path"] != "https://api.infomaniak.com" + args.path:
    raise SystemExit("Documentation operation does not match the requested route")
target = ROOT / "data/schemas" / (entry["id"] + ".json")
target.parent.mkdir(exist_ok=True)
def clean(value):
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items() if k not in {"example", "examples", "x-payload"}}
    if isinstance(value, list):
        return [clean(v) for v in value]
    return value
target.write_text(json.dumps({"catalogue_id": entry["id"], "source": entry["documentation"], "operation": clean(operation)}, ensure_ascii=False, indent=2) + "\n")
print("Saved public schema:", entry["id"])
