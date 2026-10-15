#!/usr/bin/env bash
# Re-download the official Play! web build (Play.js + Play.wasm) from
# https://playjs.purei.org and refresh checksums, provenance, and the
# version constant in site/app.js.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/site/emulator"
mkdir -p "$DEST"

curl -fsSL -o "$DEST/Play.js" "https://playjs.purei.org/Play.js"
curl -fsSL -o "$DEST/Play.wasm" "https://playjs.purei.org/Play.wasm"
curl -fsSL -o "$DEST/License.txt" "https://raw.githubusercontent.com/jpd002/Play-/master/License.txt"

grep -q "export default Play" "$DEST/Play.js"
head -c 16 "$DEST/Play.js" | grep -q "var Play"

python3 - "$ROOT" << 'PY'
import hashlib
import pathlib
import re
import sys
import urllib.request

root = pathlib.Path(sys.argv[1])
dest = root / "site" / "emulator"
js = (dest / "Play.js").read_bytes()
wasm = (dest / "Play.wasm").read_bytes()
versions = re.findall(r"0\.\d{2}-\d+-g[0-9a-f]+", wasm.decode("latin1"))
if not versions:
    raise SystemExit("Could not find an embedded Play! version in Play.wasm")
version = versions[-1]

sums = dest / "SHA256SUMS"
lines = []
for name, data in (("Play.js", js), ("Play.wasm", wasm)):
    lines.append(f"{hashlib.sha256(data).hexdigest()}  {name}")
sums.write_text("\n".join(lines) + "\n")

def header(url, field):
    req = urllib.request.Request(url, method="HEAD")
    with urllib.request.urlopen(req, timeout=60) as response:
        return response.headers.get(field, "").strip()

js_url = "https://playjs.purei.org/Play.js"
wasm_url = "https://playjs.purei.org/Play.wasm"
modified = header(wasm_url, "Last-Modified")
provenance = f"""Origin:
  {js_url}
  {wasm_url}
Upstream source: https://github.com/jpd002/Play-
Embedded version: {version}
Origin Last-Modified: {modified}
Origin ETag Play.js: {header(js_url, "ETag")}
Origin ETag Play.wasm: {header(wasm_url, "ETag")}
Downloaded: {__import__("datetime").date.today().isoformat()}
License: License.txt (BSD-style license, Jean-Philip Desjardins)

These are the prebuilt web artifacts served by the official Play!.js site.
They are vendored so GitHub Pages can host the emulator without compiling it.
Refresh them with scripts/vendor-play.sh from the repository root.
"""
(dest / "PROVENANCE.txt").write_text(provenance)

app = root / "site" / "app.js"
source = app.read_text()
updated, count = re.subn(
    r'const EMULATOR_VERSION = "[^"]*";',
    f'const EMULATOR_VERSION = "{version}";',
    source,
    count=1,
)
if count != 1:
    raise SystemExit("EMULATOR_VERSION constant not found in site/app.js")
app.write_text(updated)
print(f"Vendored Play! {version}")
PY

(
  cd "$DEST"
  sha256sum -c SHA256SUMS
)
