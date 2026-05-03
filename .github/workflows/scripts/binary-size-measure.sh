#!/usr/bin/env bash
# Locates the `.node` binding produced by `pnpm build:binding:release`, records
# its on-disk size (bytes) both as-built and after running an extra `strip
# --strip-all` pass, and writes a self-describing `size-report.json` so a
# future analysis session can consume results without any other context.
set -euo pipefail

VARIANT="${VARIANT:?VARIANT env var is required}"
PLATFORM="${PLATFORM:?PLATFORM env var is required}"

shopt -s nullglob
node_files=(crates/node_binding/*.node)
shopt -u nullglob
if [ "${#node_files[@]}" -eq 0 ]; then
  echo "::error::no .node file produced under crates/node_binding/" >&2
  ls -la crates/node_binding/ >&2 || true
  exit 1
fi
NODE_FILE="${node_files[0]}"

raw_size=$(wc -c <"$NODE_FILE" | tr -d ' ')

# Try an extra `strip --strip-all` pass on a copy to see if the linker's
# strip=true left anything on the table. macOS ships a different `strip`; on
# Windows there's no system strip - in those cases just record N/A.
stripped_size=null
strip_tool=null
case "$RUNNER_OS" in
  Linux)
    cp "$NODE_FILE" "$NODE_FILE.stripped"
    if strip --strip-all "$NODE_FILE.stripped" 2>/dev/null; then
      stripped_size=$(wc -c <"$NODE_FILE.stripped" | tr -d ' ')
      strip_tool='"strip --strip-all (binutils)"'
    fi
    rm -f "$NODE_FILE.stripped"
    ;;
  macOS)
    cp "$NODE_FILE" "$NODE_FILE.stripped"
    if strip -x "$NODE_FILE.stripped" 2>/dev/null; then
      stripped_size=$(wc -c <"$NODE_FILE.stripped" | tr -d ' ')
      strip_tool='"strip -x (cctools)"'
    fi
    rm -f "$NODE_FILE.stripped"
    ;;
  Windows)
    # PE binaries don't carry symbol tables the same way; skip.
    ;;
esac

# Echo a quick human-readable line into the job log too.
hr() { numfmt --to=iec --suffix=B "$1" 2>/dev/null || echo "$1 B"; }
echo "platform=$PLATFORM variant=$VARIANT raw=$(hr "$raw_size") stripped=$(hr "${stripped_size:-0}")"

cat >size-report.json <<JSON
{
  "schema_version": 1,
  "platform": "$PLATFORM",
  "runner_os": "$RUNNER_OS",
  "variant": "$VARIANT",
  "node_file": "$(basename "$NODE_FILE")",
  "raw_size_bytes": $raw_size,
  "stripped_size_bytes": ${stripped_size:-null},
  "strip_tool": ${strip_tool:-null},
  "git_sha": "${GITHUB_SHA:-unknown}",
  "git_ref": "${GITHUB_REF:-unknown}",
  "run_id": "${GITHUB_RUN_ID:-unknown}",
  "run_url": "${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-unknown}/actions/runs/${GITHUB_RUN_ID:-unknown}",
  "rustc_version": "$(rustc --version 2>/dev/null | tr -d '\n')"
}
JSON

echo "----- size-report.json -----"
cat size-report.json
echo
echo "----------------------------"
