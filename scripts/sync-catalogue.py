#!/usr/bin/env python3
"""Import public documentation metadata only. This never calls an account API."""
import argparse
import hashlib
import json
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
PORTAL = "https://developer.infomaniak.com/docs/api"

class Page(HTMLParser):
    page = None
    def handle_starttag(self, tag, attrs):
        self.page = dict(attrs).get("data-page", self.page)

def fetch_page(url):
    req = Request(url, headers={"Accept": "text/html", "User-Agent": "infomaniak-ai-catalogue/0.2"})
    with urlopen(req, timeout=30) as response:
        if response.geturl().split("/")[2] != "developer.infomaniak.com":
            raise ValueError("Unexpected documentation redirect")
        body = response.read(3_000_001)
    if len(body) > 3_000_000:
        raise ValueError("Documentation response too large")
    parser = Page()
    parser.feed(body.decode())
    if not parser.page:
        raise ValueError("Missing documentation data")
    return json.loads(parser.page)

def catalogue(page, checked):
    rows = {}
    def walk(group, node, inherited=False):
        staff = inherited or bool(node.get("staff"))
        if staff:
            return
        for item in node.get("items", []):
            if item.get("staff"):
                continue
            method, path = item.get("method", "").upper(), item.get("endpoint", "")
            if method not in {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"} or not path.startswith("/"):
                raise ValueError("Invalid public operation")
            key = method + " " + path
            row = {
                "id": "api." + hashlib.sha256(key.encode()).hexdigest()[:20],
                "product": group, "method": method, "path": path,
                "summary": item.get("summary", "")[:500],
                "documentation": PORTAL + "/" + method.lower() + quote(path, safe="/{}"),
            }
            if key in rows and rows[key] != row:
                raise ValueError("Conflicting catalogue operation")
            rows[key] = row
        for child in node.get("sub_categories", {}).values():
            walk(group, child, staff)
    for group, node in page["props"]["navigation"].items():
        walk(group, node)
    ordered = sorted(rows.values(), key=lambda row: (row["product"], row["path"], row["method"]))
    digest = hashlib.sha256(json.dumps(ordered, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"source": PORTAL, "checked_at": checked, "sha256": digest, "operations": ordered}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="Saved public Inertia JSON; no network access")
    parser.add_argument("--refresh", action="store_true", help="Fetch the public documentation once")
    parser.add_argument("--checked-at", required=True, help="UTC date of the source snapshot")
    args = parser.parse_args()
    if bool(args.source) == args.refresh:
        parser.error("Choose --source or --refresh")
    page = json.loads(args.source.read_text()) if args.source else fetch_page(PORTAL)
    output = catalogue(page, args.checked_at)
    target = ROOT / "data/catalogue.json"
    target.parent.mkdir(exist_ok=True)
    target.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
    print(f"Imported {len(output['operations'])} public method/path pairs; execution policy unchanged.")

if __name__ == "__main__":
    main()
