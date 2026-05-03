#!/usr/bin/env python3
"""Aggregate per-job size-report.json files into a single markdown summary
table and a combined JSON document.

Usage: binary-size-summarize.py <reports-dir>

Behavior:
  - Reads every *.json file under <reports-dir> recursively.
  - Computes per-platform deltas vs. the `baseline` variant on that platform.
  - Prints a markdown table to stdout (intended to be redirected into
    $GITHUB_STEP_SUMMARY).
  - Writes `combined-size-reports.json` next to the script's CWD so the
    workflow can upload it as a single, easily-downloadable artifact for
    later analysis.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def fmt_bytes(n: int | None) -> str:
    if n is None:
        return "—"
    units = ["B", "KiB", "MiB", "GiB"]
    f = float(n)
    for u in units:
        if f < 1024 or u == units[-1]:
            return f"{f:,.2f} {u}" if u != "B" else f"{int(f):,} B"
        f /= 1024
    return f"{n} B"


def fmt_delta(cur: int, base: int) -> str:
    if base == 0:
        return "—"
    diff = cur - base
    pct = 100.0 * diff / base
    sign = "+" if diff >= 0 else ""
    return f"{sign}{diff:,} B ({sign}{pct:.2f}%)"


def main(reports_dir: str) -> int:
    root = Path(reports_dir)
    reports: list[dict] = []
    for p in sorted(root.rglob("*.json")):
        try:
            reports.append(json.loads(p.read_text()))
        except Exception as e:  # noqa: BLE001
            print(f"<!-- skipped {p}: {e} -->")

    if not reports:
        print("# Binary size experiment\n\n_No reports found._")
        return 0

    # Persist a combined document so a future analysis phase can download a
    # single artifact and consume it without any other context.
    Path("combined-size-reports.json").write_text(
        json.dumps({"schema_version": 1, "reports": reports}, indent=2)
    )

    # Group by platform, then sort variants with `baseline` first.
    by_platform: dict[str, list[dict]] = {}
    for r in reports:
        by_platform.setdefault(r["platform"], []).append(r)

    out: list[str] = []
    out.append("# Binary size experiment\n")
    out.append(
        "Each row is one CI job that built `crates/node_binding/*.node` with "
        "a single optimization knob flipped. `Δ vs baseline` is computed "
        "per-platform against the `baseline` row of that platform.\n"
    )

    any_sha = next((r.get("git_sha") for r in reports if r.get("git_sha")), None)
    any_url = next((r.get("run_url") for r in reports if r.get("run_url")), None)
    if any_sha:
        out.append(f"- Commit: `{any_sha}`")
    if any_url:
        out.append(f"- Run: {any_url}")
    out.append("")

    variant_order = [
        "baseline",
        "opt-level-s-global",
        "opt-level-z-global",
        "lto-thin",
        "lto-off",
        "no-build-std",
        "no-info-level",
    ]

    def variant_key(r: dict) -> tuple[int, str]:
        v = r["variant"]
        try:
            return (variant_order.index(v), v)
        except ValueError:
            return (len(variant_order), v)

    for platform in sorted(by_platform):
        rows = sorted(by_platform[platform], key=variant_key)
        baseline = next((r for r in rows if r["variant"] == "baseline"), None)
        out.append(f"## `{platform}`\n")
        out.append(
            "| Variant | Raw size | Δ vs baseline | After extra `strip` | Δ vs raw |"
        )
        out.append("| --- | ---: | ---: | ---: | ---: |")
        for r in rows:
            raw = r["raw_size_bytes"]
            stripped = r.get("stripped_size_bytes")
            delta_base = (
                fmt_delta(raw, baseline["raw_size_bytes"])
                if baseline and r is not baseline
                else ("—" if not baseline else "0 B (baseline)")
            )
            delta_strip = fmt_delta(stripped, raw) if stripped is not None else "—"
            out.append(
                f"| `{r['variant']}` | {fmt_bytes(raw)} | {delta_base} | "
                f"{fmt_bytes(stripped)} | {delta_strip} |"
            )
        out.append("")

    out.append("---")
    out.append("")
    out.append(
        "The full per-job JSON reports plus a `combined-size-reports.json` "
        "document are uploaded as the `binary-size-experiment-results` "
        "artifact for offline analysis."
    )

    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "reports"))
