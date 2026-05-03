// Write a managed block of `[profile.release.package.<crate>]` overrides
// into Cargo.toml based on a hot/cold classification. Idempotent: the block
// is delimited by sentinel comments, so re-running replaces it cleanly and
// does not disturb hand-written `[profile.release.package.*]` sections.
//
// Hot crates → opt-level = 3   (configurable via --hot-opt-level)
// Cold crates → opt-level = "z" (configurable via --cold-opt-level)
//
// We *only* emit overrides whose effective opt-level differs from the
// workspace [profile.release] default. So:
//   - With the *current* workspace default `opt-level = 3`, only cold
//     overrides are emitted (recovers ~31% of the global-z size win at
//     fixed throughput on the SWC hot path — see PGO.md).
//   - With the **aggressive-size** mode (`--workspace-default z`), the
//     workspace `[profile.release].opt-level` line is rewritten to "z" and
//     hot crates are bumped *up* to opt-level=3 in the managed block. Cold
//     crates are no-ops because they already match the workspace default.
//     This applies to **third-party** crates too: classification of
//     `swc_ecma_*`, `hashbrown`, `indexmap`, etc. drives the per-package
//     overrides exactly the same way as for first-party crates.
//
// `rustc` does NOT support an opt-level above 3 — there is no "O4". To
// push *individual hot functions/loops* beyond `opt-level = 3` requires
// source-level annotations, not Cargo profiles:
//   - `#[inline(always)]`            (stable)
//   - `#[cold]` on cold helpers      (stable)
//   - `#[optimize(speed)]`           (nightly: rust-lang/rust#54882)
// Cargo profile overrides are package-granular; see `pgo-classify-functions.ts`
// + `PGO.md` for the function-level classifier whose output drives those
// source-level changes.

import { readFileSync, writeFileSync } from "node:fs";
import { argv, env, exit } from "node:process";

import type { ClassifiedCrate } from "./pgo-classify.ts";

export const BEGIN_MARKER = "# >>> pgo-managed-overrides >>>";
export const END_MARKER = "# <<< pgo-managed-overrides <<<";

const BLOCK_RE = new RegExp(
	String.raw`\r?\n?${escapeRe(BEGIN_MARKER)}[\s\S]*?${escapeRe(END_MARKER)}\r?\n?`,
	"m"
);

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse the workspace [profile.release] opt-level. Defaults to "3" if not
 * set or if the section is missing. Recognizes double-quoted, single-quoted
 * (TOML literal strings), and bare-token forms.
 */
export function readWorkspaceReleaseOptLevel(cargoToml: string): string {
	const m = cargoToml.match(
		/^\[profile\.release\]\r?\n([\s\S]*?)(?=^\[)/m
	);
	if (!m) return "3";
	const body = m[1];
	const km = body.match(
		/^\s*opt-level\s*=\s*(?:"([^"]+)"|'([^']+)'|(\S+))/m
	);
	if (!km) return "3";
	return km[1] ?? km[2] ?? km[3];
}

// Sentinel comment used to restore the original workspace opt-level on
// `pgo-run.ts revert`. Survives across runs, on both LF and CRLF
// checkouts. Stored next to the (rewritten) opt-level line.
const WS_RESTORE_RE =
	/[ \t]*#[ \t]*pgo-managed-original-opt-level=([^\r\n#]+?)[ \t]*(?=\r?\n|$)/;
const WS_OPT_LINE_RE =
	/^([ \t]*opt-level[ \t]*=[ \t]*)(\S+)([ \t]*)(#.*)?$/m;

function originalOptLevelTag(level: string): string {
	// Strip surrounding quotes for stable round-trip.
	return ` # pgo-managed-original-opt-level=${stripQuotes(level)}`;
}

/**
 * Rewrite the workspace `[profile.release].opt-level` line in-place,
 * preserving the original value in a `# pgo-managed-original-opt-level=…`
 * comment so `revert` can restore it byte-identically.
 *
 * Idempotent: if the file already has the sentinel comment, the original
 * value is preserved and only the live value is updated.
 *
 * Returns the modified file text. If `[profile.release]` has no opt-level
 * line at all, one is inserted.
 */
export function setWorkspaceReleaseOptLevel(
	cargoToml: string,
	newLevel: string
): string {
	const newToken = formatLevel(newLevel);
	const sectionMatch = cargoToml.match(
		/^(\[profile\.release\]\r?\n)([\s\S]*?)(?=^\[)/m
	);
	if (!sectionMatch) {
		// No [profile.release] section at all — leave file alone.
		return cargoToml;
	}
	const sectionBody = sectionMatch[2];
	const optMatch = sectionBody.match(WS_OPT_LINE_RE);
	if (!optMatch) {
		// Insert a fresh opt-level line at the top of the section, with a
		// restore tag for an implicit "3" default.
		const inserted = `opt-level = ${newToken}${originalOptLevelTag("3")}\n`;
		const newBody = inserted + sectionBody;
		return cargoToml.replace(sectionBody, newBody);
	}
	const oldToken = optMatch[2];
	const trailing = optMatch[4] ?? "";
	const existingTag = trailing.match(WS_RESTORE_RE);
	const originalValue = existingTag
		? existingTag[1].trim()
		: stripQuotes(oldToken);
	const restored =
		`${optMatch[1]}${newToken}${optMatch[3] ?? ""}${originalOptLevelTag(originalValue)}`;
	const newSectionBody = sectionBody.replace(WS_OPT_LINE_RE, restored);
	return cargoToml.replace(sectionBody, newSectionBody);
}

/**
 * Restore the workspace `[profile.release].opt-level` to the value
 * recorded in the `# pgo-managed-original-opt-level=…` sentinel comment,
 * removing the comment. No-op if the comment is absent.
 */
export function unsetWorkspaceReleaseOptLevel(cargoToml: string): string {
	const sectionMatch = cargoToml.match(
		/^(\[profile\.release\]\r?\n)([\s\S]*?)(?=^\[)/m
	);
	if (!sectionMatch) return cargoToml;
	const sectionBody = sectionMatch[2];
	const optMatch = sectionBody.match(WS_OPT_LINE_RE);
	if (!optMatch) return cargoToml;
	const trailing = optMatch[4] ?? "";
	const tag = trailing.match(WS_RESTORE_RE);
	if (!tag) return cargoToml;
	const originalValue = tag[1].trim();
	const restoredToken = formatLevel(originalValue);
	const cleanedTrailing = trailing.replace(WS_RESTORE_RE, "").trimEnd();
	// If removing the sentinel left no trailing comment at all, drop the
	// pre-comment whitespace too so the round-trip is byte-identical.
	const ws = cleanedTrailing === "" ? "" : (optMatch[3] ?? "");
	const restoredLine = `${optMatch[1]}${restoredToken}${ws}${cleanedTrailing}`;
	const newSectionBody = sectionBody.replace(WS_OPT_LINE_RE, restoredLine);
	return cargoToml.replace(sectionBody, newSectionBody);
}

/**
 * Find every `[profile.release.package.<crate>]` section already present in
 * the file *outside* the managed block. We must not emit duplicate keys
 * for these — TOML rejects duplicate tables and `cargo metadata` errors.
 *
 * Quoted forms `[profile.release.package."crate-with-dash"]` are handled.
 */
export function existingPackageOverrides(cargoToml: string): Set<string> {
	const withoutManaged = cargoToml.replace(BLOCK_RE, "\n");
	const out = new Set<string>();
	const re = /^\[profile\.release\.package\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]/gm;
	let m: RegExpExecArray | null;
	while ((m = re.exec(withoutManaged)) !== null) {
		out.add(m[1] ?? m[2]);
	}
	return out;
}


export interface RenderOptions {
	workspaceDefault?: string; // override the auto-detected workspace opt-level
	hotOptLevel?: string; // default "3"
	coldOptLevel?: string; // default "\"z\""
}

/**
 * Render the managed block (markers + per-crate sections) for a
 * classification. Returns a string ending in a newline (empty string if no
 * overrides are needed).
 */
export function renderManagedBlock(
	classification: { hot: readonly ClassifiedCrate[]; cold: readonly ClassifiedCrate[] },
	cargoToml: string,
	opts: RenderOptions = {}
): string {
	const wsDefault = opts.workspaceDefault ?? readWorkspaceReleaseOptLevel(cargoToml);
	const hotLevel = opts.hotOptLevel ?? "3";
	const coldLevel = opts.coldOptLevel ?? '"z"';
	const existing = existingPackageOverrides(cargoToml);

	const lines: string[] = [];
	lines.push(BEGIN_MARKER);
	lines.push("# Generated by .github/workflows/scripts/pgo-apply-overrides.ts.");
	lines.push("# Do not edit by hand — re-run pgo-run.ts to refresh.");
	lines.push(`# Workspace [profile.release].opt-level detected as ${wsDefault}.`);

	let emittedAny = false;
	let skippedExisting = 0;
	const hotsToEmit = wsDefault === hotLevel ? [] : classification.hot;
	for (const c of hotsToEmit) {
		if (existing.has(c.crate)) {
			skippedExisting++;
			continue;
		}
		lines.push("");
		lines.push(`[profile.release.package.${c.crate}]`);
		lines.push(`opt-level = ${formatLevel(hotLevel)}  # hot: ${(c.pct * 100).toFixed(2)}% (${c.reason})`);
		emittedAny = true;
	}
	const coldsToEmit = wsDefault === stripQuotes(coldLevel) ? [] : classification.cold;
	for (const c of coldsToEmit) {
		if (existing.has(c.crate)) {
			skippedExisting++;
			continue;
		}
		lines.push("");
		lines.push(`[profile.release.package.${c.crate}]`);
		const pct = c.pct > 0 ? `${(c.pct * 100).toFixed(2)}%` : "unsampled";
		lines.push(`opt-level = ${coldLevel}  # cold: ${pct} (${c.reason})`);
		emittedAny = true;
	}
	if (skippedExisting > 0) {
		lines.splice(
			4,
			0,
			`# Skipped ${skippedExisting} crate(s) with hand-written [profile.release.package.*] overrides.`
		);
	}
	if (!emittedAny) {
		lines.push("# (no overrides needed — workspace default already matches)");
	}

	lines.push(END_MARKER);
	return lines.join("\n") + "\n";
}

function formatLevel(level: string): string {
	// "3" → 3, "s" → "s", `"z"` already-quoted → keep.
	if (/^\d+$/.test(level)) return level;
	if (level.startsWith('"')) return level;
	return `"${level}"`;
}

function stripQuotes(level: string): string {
	return level.replace(/^"|"$/g, "");
}

/**
 * Replace any existing managed block in Cargo.toml with `block`. If no
 * managed block is present, append `block` to end-of-file with a leading
 * blank line.
 */
export function writeManagedBlock(cargoToml: string, block: string): string {
	if (BLOCK_RE.test(cargoToml)) {
		return cargoToml.replace(BLOCK_RE, "\n" + block);
	}
	const trailingNewline = cargoToml.endsWith("\n") ? "" : "\n";
	return cargoToml + trailingNewline + "\n" + block;
}

/**
 * Remove the managed block (if any) — used by `pgo-run.ts --revert`.
 */
export function removeManagedBlock(cargoToml: string): string {
	return cargoToml.replace(BLOCK_RE, "");
}

/**
 * Apply overrides to a Cargo.toml file on disk.
 */
export function applyOverridesToFile(
	cargoTomlPath: string,
	classification: { hot: readonly ClassifiedCrate[]; cold: readonly ClassifiedCrate[] },
	opts: RenderOptions = {}
): { changed: boolean } {
	const before = readFileSync(cargoTomlPath, "utf8");
	const block = renderManagedBlock(classification, before, opts);
	const after = writeManagedBlock(before, block);
	if (after === before) return { changed: false };
	writeFileSync(cargoTomlPath, after);
	return { changed: true };
}

// --- Script entry point ---

function isMain(): boolean {
	const url = import.meta.url;
	return Boolean(argv[1] && url === `file://${argv[1]}`);
}

if (isMain()) {
	const cargoTomlPath = env.CARGO_TOML ?? "Cargo.toml";
	const profilePath = argv[2];
	if (!profilePath) {
		console.error("Usage: pgo-apply-overrides.ts <profile.json>");
		exit(2);
	}
	import("./pgo-profile.ts").then(async pp => {
		const cls = await import("./pgo-classify.ts");
		const profile = pp.readProfile(profilePath);
		const classification = cls.classify(profile);
		const { changed } = applyOverridesToFile(cargoTomlPath, classification);
		console.log(
			`overrides ${changed ? "updated" : "unchanged"} in ${cargoTomlPath}: ${classification.hot.length} hot, ${classification.cold.length} cold`
		);
	});
}
