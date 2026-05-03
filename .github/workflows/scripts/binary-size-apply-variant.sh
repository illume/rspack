#!/usr/bin/env bash
# Patches Cargo.toml and/or crates/node_binding/scripts/build.js based on
# $VARIANT to flip a single binary-size optimization knob, then prints a
# diff so the change is visible in the CI log.
#
# Variants (kept in sync with .github/workflows/binary-size-experiment.yml):
#   baseline             - no patch
#   opt-level-s-global   - [profile.release] opt-level = "s"
#   opt-level-z-global   - [profile.release] opt-level = "z"
#   lto-thin             - [profile.release] lto = "thin"
#   lto-off              - [profile.release] lto = "off"
#   no-build-std         - drop -Zbuild-std=panic_abort,std from build.js
#   no-info-level        - drop the `info-level` feature push from build.js
set -euo pipefail

VARIANT="${VARIANT:?VARIANT env var is required}"
CARGO=Cargo.toml
BUILD_JS=crates/node_binding/scripts/build.js

# Helper: replace the single line that sets a key under the [profile.release]
# header in the workspace Cargo.toml (without touching per-package overrides).
patch_release_key() {
  local key="$1" new_value="$2"
  python3 - "$CARGO" "$key" "$new_value" <<'PY'
import re, sys, pathlib
path, key, new_value = sys.argv[1], sys.argv[2], sys.argv[3]
src = pathlib.Path(path).read_text()
# Match the [profile.release] section body (until next [section] header).
m = re.search(r'(?ms)^\[profile\.release\]\n(.*?)(?=^\[)', src)
if not m:
    sys.exit(f'[profile.release] not found in {path}')
body = m.group(1)
pat = re.compile(rf'(?m)^(\s*{re.escape(key)}\s*=\s*)("[^"]*"|\S+)(\s*(?:#.*)?)$')
if not pat.search(body):
    sys.exit(f'key {key} not found under [profile.release]')
new_body = pat.sub(rf'\g<1>"{new_value}"\g<3>', body)
pathlib.Path(path).write_text(src[:m.start(1)] + new_body + src[m.end(1):])
PY
}

case "$VARIANT" in
  baseline)
    echo "::notice::variant=baseline (no patch applied)"
    ;;
  opt-level-s-global)
    patch_release_key opt-level s
    ;;
  opt-level-z-global)
    patch_release_key opt-level z
    ;;
  lto-thin)
    patch_release_key lto thin
    ;;
  lto-off)
    patch_release_key lto off
    ;;
  no-build-std)
    # Drop the -Zbuild-std flag injection. The surrounding `if (use_build_std)`
    # block stays, just emits nothing useful, which is harmless.
    python3 - "$BUILD_JS" <<'PY'
import pathlib, re, sys
p = pathlib.Path(sys.argv[1])
s = p.read_text()
new = re.sub(r'\n\s*args\.push\("-Zbuild-std=panic_abort,std"\);\n', '\n', s)
if new == s:
    sys.exit('-Zbuild-std push not found in build.js')
p.write_text(new)
PY
    ;;
  no-info-level)
    python3 - "$BUILD_JS" <<'PY'
import pathlib, re, sys
p = pathlib.Path(sys.argv[1])
s = p.read_text()
new = re.sub(r'\n\s*features\.push\("info-level"\);\n', '\n', s)
if new == s:
    sys.exit('info-level push not found in build.js')
p.write_text(new)
PY
    ;;
  *)
    echo "::error::unknown VARIANT: $VARIANT" >&2
    exit 2
    ;;
esac

echo "----- diff after applying variant=$VARIANT -----"
git --no-pager diff -- "$CARGO" "$BUILD_JS" || true
echo "------------------------------------------------"
