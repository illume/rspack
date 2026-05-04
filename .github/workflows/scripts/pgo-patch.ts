// Cargo-patch driven, profile-guided source rewriting for third-party crates.
//
// Goal (per user request): default *vendored third-party crates* to
// `opt-level = "z"` (size), and inject **source-level** speed markers
// (`#[optimize(speed)]`, nightly) on the hot functions identified by the
// stored perf profile. This goes one step finer than `pgo-apply-overrides`,
// which is package-granular: that gives us "whole crate at =3 or =z", while
// this module lets us split *inside* a hot crate so cold helpers in
// `swc_ecma_minifier` shrink while `Pure::visit_mut_expr` keeps full speed.
//
// How:
//
//   1. Read the stored PGO profile.
//   2. Group hot functions (top symbols whose cumulative share ≤ threshold,
//      same algorithm as `pgo-classify-functions.ts`) by their attributed
//      crate. Cold functions = the remaining attributable top symbols within
//      crates that contain at least one hot function (i.e. crates we are
//      already vendoring).
//   3. Strip the function name out of each demangled symbol so we have a
//      simple identifier to grep for in the vendored sources.
//   4. Emit, for each such crate:
//        - A `[patch.crates-io]` TOML fragment pointing the crate at a
//          local vendored path (e.g. `vendor/<crate>`).
//        - A "patch plan" JSON describing which fn-name identifiers should
//          receive `#[optimize(speed)]` (hot) and which should receive
//          `#[optimize(size)]` (cold). The crate root (`src/lib.rs`) gets
//          `#![feature(optimize_attribute)]` + a crate-level
//          `#![cfg_attr(not(any(test, doctest)), optimize(size))]` so the
//          *default* for everything in the crate is size. Hot fns lift back
//          to speed via the per-function attribute.
//
//   5. `applyPlanToVendoredCrate(crateDir, plan)` walks the `.rs` files in a
//      vendored source tree and applies the rewrite via a regex anchored at
//      `fn <name>(` boundaries. Idempotent — if the attribute is already
//      present, the line is left alone.
//
// Why source-level (vs `[profile.release.package.X]`)? Cargo profile
// overrides cannot go below the package boundary — there is no
// `[profile.release.package.X.function.Y]`. The only mechanism Rust offers
// for "this fn at speed, that fn at size, everything else size" inside a
// single crate is the source attribute. The cargo-patch indirection is what
// lets us do it for *third-party* crates without forking them upstream.
//
// Stable Rust does not have `#[optimize(...)]`; it lives behind the
// `optimize_attribute` feature. The release build already pins
// `nightly-2026-04-16` (see `crates/node_binding/scripts/build.js`), so this
// module emits feature gates and assumes a nightly toolchain. On stable, the
// patched crates fail to build, which is intentional and louder than a
// silent no-op.

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { classifyFunctions } from "./pgo-classify-functions.ts";
import type { PgoProfile } from "./pgo-profile.ts";

/** ───────────────────────── plan model ────────────────────────── */

export interface PatchPlanFunction {
	/** Demangled symbol from the perf profile (kept for traceability). */
	symbol: string;
	/** Bare fn identifier extracted from the symbol (`visit_mut_expr`, `eq`, …). */
	fnName: string;
	/** Share of total samples, 0..1. */
	pct: number;
	decision: "hot" | "cold";
}

export interface PatchPlanCrate {
	crate: string;
	/**
	 * Where the source rewrite should be applied, relative to the workspace
	 * root. For `kind === "third-party"` this is the `[patch.crates-io]`
	 * target (e.g. `vendor/<crate>`); for `kind === "workspace"` this is the
	 * workspace member directory (e.g. `crates/<crate>`).
	 */
	patchPath: string;
	/** Default crate-level decision; applied at `lib.rs` as `#![cfg_attr(..., optimize(size))]`. */
	defaultDecision: "hot" | "cold";
	/**
	 * `"third-party"` crates need a `[patch.crates-io]` redirection plus a
	 * `[profile.release.package.X] opt-level = "z"` size default in Cargo.
	 * `"workspace"` crates already live in `crates/<name>/` and inherit the
	 * workspace-default `[profile.release].opt-level` (set to `"z"` by the
	 * `apply --workspace-default z` step), so we only inject per-fn markers
	 * — no cargo-side changes.
	 */
	kind: "third-party" | "workspace";
	hot: PatchPlanFunction[];
	cold: PatchPlanFunction[];
}

export interface PatchPlan {
	schema_version: 1;
	created_at: string;
	threshold: number;
	vendor_root: string;
	/** Sorted descending by cumulative profile share inside each crate. */
	crates: PatchPlanCrate[];
}

export interface BuildPatchPlanOptions {
	/** Cumulative share for the hot bucket, default 0.50 (matches `classifyFunctions`). */
	hotCumulativeShare?: number;
	/** Workspace-relative root for the vendored crates. Default `"vendor"`. */
	vendorRoot?: string;
	/** Restrict to these crates; empty/undefined = every crate that has a hot symbol. */
	restrictToCrates?: readonly string[];
	/**
	 * When provided, crates whose name resolves to `<repoRoot>/crates/<name>/Cargo.toml`
	 * are classified as `kind: "workspace"` and get in-place source markers
	 * rather than `[patch.crates-io]` + `[profile.release.package.X]` cargo
	 * indirection. Pair with `apply --workspace-default z` to get
	 * "workspace-wide `=z` plus per-fn `=speed` on the workspace hotspots".
	 */
	repoRoot?: string;
	/**
	 * Custom workspace member detector for testing. Defaults to
	 * checking `<repoRoot>/crates/<name>/Cargo.toml` existence on disk.
	 */
	isWorkspaceMember?: (crate: string) => boolean;
}

export const PATCH_PLAN_SCHEMA_VERSION = 1 as const;

/**
 * Strip a demangled Rust symbol down to the bare leaf-fn identifier we can
 * grep for in source. Handles the three forms emitted by the Rust demangler:
 *
 *   "swc_ecma_utils::may_have_side_effects"
 *     → "may_have_side_effects"
 *
 *   "<swc_ecma_minifier::compress::pure::Pure as ...::VisitMut>::visit_mut_expr"
 *     → "visit_mut_expr"
 *
 *   "<swc_ecma_parser::lexer::Lexer>::read_keyword_with"
 *     → "read_keyword_with"
 *
 * Trailing `::h<hash>` mangles, generic parameter lists and trailing
 * monomorphisation suffixes are stripped. If the symbol has no clear leaf,
 * returns `null` (caller drops it).
 */
export function extractFunctionName(symbol: string): string | null {
	let s = symbol.trim();
	// Drop trailing legacy hash suffix `::h0123456789abcdef`.
	s = s.replace(/::h[0-9a-f]{16}$/, "");
	// Drop trailing generic args at top level: `foo::bar<T, U>` and turbofish `foo::bar::<T, U>`.
	// Iterate so nested generics (`Foo<Bar<T>>`) collapse cleanly.
	while (/<[^<>]*>$/.test(s)) {
		s = s.replace(/<[^<>]*>$/, "");
	}
	// Trim a turbofish trailing `::` (from e.g. `foo::bar::<T>` → `foo::bar::`).
	s = s.replace(/::$/, "");
	// Take the substring after the last `::` not inside angle brackets.
	let depth = 0;
	let lastSplit = -1;
	for (let i = 0; i < s.length - 1; i++) {
		const c = s[i];
		if (c === "<") depth++;
		else if (c === ">") depth--;
		else if (depth === 0 && c === ":" && s[i + 1] === ":") {
			lastSplit = i;
		}
	}
	if (lastSplit !== -1) s = s.slice(lastSplit + 2);
	// Drop leading '<' / trailing '>' if a single segment is wrapped (rare).
	s = s.replace(/^<+|>+$/g, "");
	// Drop trailing generic args once more for cases like `eq::<T>`.
	s = s.replace(/<[^<>]*>$/, "");
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return null;
	return s;
}

/**
 * Group classified hot/cold functions by attributed crate. Default decision
 * for the crate is "cold" so the lib-level attribute defaults to size.
 */
export function buildPatchPlan(
	profile: PgoProfile,
	opts: BuildPatchPlanOptions = {}
): PatchPlan {
	const threshold = opts.hotCumulativeShare ?? 0.5;
	const vendorRoot = opts.vendorRoot ?? "vendor";
	const restrict = opts.restrictToCrates && opts.restrictToCrates.length > 0
		? new Set(opts.restrictToCrates)
		: null;

	const cls = classifyFunctions(profile, {
		hotCumulativeShare: threshold,
		restrictToCrates: restrict ? [...restrict] : undefined,
	});

	// Workspace-membership detector. The default reads the filesystem; tests
	// inject a mock via `opts.isWorkspaceMember`.
	const isWorkspaceMember: (c: string) => boolean = opts.isWorkspaceMember
		?? (opts.repoRoot
			? (c) => {
				try {
					return statSync(join(opts.repoRoot!, "crates", c, "Cargo.toml")).isFile();
				} catch {
					return false;
				}
			}
			: () => false);

	const byCrate = new Map<string, { hot: PatchPlanFunction[]; cold: PatchPlanFunction[]; share: number }>();

	const ingest = (
		bucket: "hot" | "cold",
		entries: typeof cls.hot
	): void => {
		for (const e of entries) {
			const fnName = extractFunctionName(e.symbol);
			if (!fnName) continue;
			let agg = byCrate.get(e.crate);
			if (!agg) {
				agg = { hot: [], cold: [], share: 0 };
				byCrate.set(e.crate, agg);
			}
			(bucket === "hot" ? agg.hot : agg.cold).push({
				symbol: e.symbol,
				fnName,
				pct: e.pct,
				decision: bucket,
			});
			agg.share += e.pct;
		}
	};
	ingest("hot", cls.hot);
	ingest("cold", cls.cold);

	// Drop crates with no hot functions — there is no point patching a crate
	// that doesn't contain any speed-critical symbol; the package-level
	// `[profile.release.package.X] opt-level = "z"` already covers it.
	const crates: PatchPlanCrate[] = [];
	for (const [name, agg] of byCrate) {
		if (agg.hot.length === 0) continue;
		// Stable order inside each bucket: descending by pct, then symbol.
		const cmp = (a: PatchPlanFunction, b: PatchPlanFunction): number =>
			b.pct - a.pct || a.symbol.localeCompare(b.symbol);
		agg.hot.sort(cmp);
		agg.cold.sort(cmp);
		crates.push({
			crate: name,
			patchPath: isWorkspaceMember(name) ? `crates/${name}` : `${vendorRoot}/${name}`,
			kind: isWorkspaceMember(name) ? "workspace" : "third-party",
			defaultDecision: "cold",
			hot: agg.hot,
			cold: agg.cold,
		});
	}
	// Sort crates by total share of attributed samples descending, so the
	// top of the plan is the one whose patch matters most.
	crates.sort((a, b) => {
		const sumA = a.hot.reduce((n, f) => n + f.pct, 0) + a.cold.reduce((n, f) => n + f.pct, 0);
		const sumB = b.hot.reduce((n, f) => n + f.pct, 0) + b.cold.reduce((n, f) => n + f.pct, 0);
		return sumB - sumA || a.crate.localeCompare(b.crate);
	});

	return {
		schema_version: PATCH_PLAN_SCHEMA_VERSION,
		created_at: new Date().toISOString(),
		threshold,
		vendor_root: vendorRoot,
		crates,
	};
}

/** ──────────────────────── TOML emission ──────────────────────── */

/**
 * Render a `[patch.crates-io]` block that points each plan crate at its
 * local vendored path. The block is delimited by sentinel comments so it
 * can be cleanly applied/removed alongside the existing `pgo-apply-overrides`
 * managed block.
 */
export const PATCH_BEGIN_MARKER = "# >>> pgo-managed-patch-crates-io >>>";
export const PATCH_END_MARKER = "# <<< pgo-managed-patch-crates-io <<<";

export function renderCargoPatchSection(plan: PatchPlan): string {
	const lines: string[] = [];
	lines.push(PATCH_BEGIN_MARKER);
	// Cargo redirection only applies to third-party crates. Workspace crates
	// already live at `crates/<name>/`; we just inject per-fn markers in
	// place. The workspace `[profile.release].opt-level` knob (set by
	// `apply --workspace-default z`) already gives them a size default.
	// `kind` is undefined in legacy plans built before workspace support
	// was added — those default to "third-party" for back-compat.
	const tp = plan.crates.filter(c => (c.kind ?? "third-party") === "third-party");
	const ws = plan.crates.filter(c => c.kind === "workspace");
	lines.push(
		`# Generated by pgo-patch.ts; ${tp.length} third-party crate(s) + ${ws.length} workspace crate(s)`
	);
	lines.push(
		`# at default opt-level="z" with #[optimize(speed)] markers on ${plan.crates.reduce((n, c) => n + c.hot.length, 0)} hot fn(s).`
	);
	if (tp.length > 0) {
		lines.push("[patch.crates-io]");
		for (const c of tp) {
			lines.push(`${c.crate} = { path = "${c.patchPath}" }`);
		}
		// Crate-wide default for the patched third-party crates: opt-level="z".
		// The per-fn `#[optimize(speed)]` markers in the rewritten sources
		// lift hot fns back up. We can't do this with `#![cfg_attr(...,
		// optimize(size))]` at the lib root because rustc rejects
		// `#[optimize]` on non-fn items ("`#[optimize]` can only be applied
		// to functions"); the only way to affect the *whole* crate's
		// codegen is the Cargo profile knob.
		lines.push("");
		for (const c of tp) {
			lines.push(`[profile.release.package.${c.crate}]`);
			lines.push(`opt-level = "z"`);
		}
	}
	if (ws.length > 0) {
		// Workspace crates: no Cargo entry needed. Just record their names
		// for traceability so a reader of Cargo.toml can see what's been
		// touched in-place.
		lines.push("");
		lines.push(`# Workspace crate(s) with in-place per-fn markers (no [patch] needed):`);
		for (const c of ws) {
			lines.push(`#   - ${c.crate} → ${c.patchPath}`);
		}
	}
	lines.push(PATCH_END_MARKER);
	return lines.join("\n") + "\n";
}

const PATCH_BLOCK_RE = (() => {
	const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(
		String.raw`${esc(PATCH_BEGIN_MARKER)}[\s\S]*?${esc(PATCH_END_MARKER)}\r?\n?`,
		"m"
	);
})();

export function writePatchSection(cargoToml: string, plan: PatchPlan): string {
	const block = renderCargoPatchSection(plan);
	if (PATCH_BLOCK_RE.test(cargoToml)) {
		return cargoToml.replace(PATCH_BLOCK_RE, block);
	}
	const sep = cargoToml.endsWith("\n") ? "" : "\n";
	return cargoToml + sep + block;
}

export function removePatchSection(cargoToml: string): string {
	return cargoToml.replace(PATCH_BLOCK_RE, "");
}

/** ─────────────────────── source rewriting ────────────────────── */

/**
 * Sentinel comment we leave on each injected attribute so re-runs are
 * idempotent (we recognise our own work and don't double-insert). Also
 * lets a human grep for everything we touched.
 */
export const ATTR_SENTINEL = "// pgo-managed";

const SPEED_ATTR = `#[optimize(speed)] ${ATTR_SENTINEL}`;
const SIZE_ATTR = `#[optimize(size)] ${ATTR_SENTINEL}`;

/**
 * Crate-root header inserted at the top of `lib.rs`. Must precede any other
 * inner attributes per Rust grammar — but in practice every crate already
 * has its own `#![…]` lines, so we insert above whatever's there. The
 * outer guard only enables the feature on nightly so that a stable cargo
 * check fails *loudly* (with the well-known feature-gate error) instead of
 * silently dropping the optimisation hint.
 */
export function renderLibHeader(_defaultDecision: "hot" | "cold"): string {
	// Note: `#[optimize(speed|size)]` is a *function-level* attribute on
	// nightly (RFC 2867 / `optimize_attribute` feature). It cannot be applied
	// at the crate root via `#![…]` — rustc rejects with "`#[optimize]` can
	// only be applied to functions". So the lib header only enables the
	// feature gate; the *crate-wide default* size optimisation is delivered
	// via `[profile.release.package.<crate>] opt-level = "z"` in the
	// generated `[patch.crates-io]` block, and the per-fn `#[optimize(speed)]`
	// markers lift the hot fns back up.
	return [
		`// pgo-managed: profile-guided optimisation markers begin`,
		`#![feature(optimize_attribute)]`,
		`// pgo-managed: profile-guided optimisation markers end`,
		"",
	].join("\n");
}

const LIB_HEADER_RE = /\/\/ pgo-managed: profile-guided optimisation markers begin\r?\n[\s\S]*?\/\/ pgo-managed: profile-guided optimisation markers end\r?\n?/;

export function ensureLibHeader(libRs: string, defaultDecision: "hot" | "cold"): string {
	const desired = renderLibHeader(defaultDecision);
	if (LIB_HEADER_RE.test(libRs)) {
		return libRs.replace(LIB_HEADER_RE, desired);
	}
	return desired + libRs;
}

export function stripLibHeader(libRs: string): string {
	return libRs.replace(LIB_HEADER_RE, "");
}

/**
 * Strip every per-fn `#[optimize(speed|size)] // pgo-managed` line that
 * `rewriteSource` previously injected. Lines without our sentinel are
 * untouched, so a hand-written `#[optimize(...)]` (with no `// pgo-managed`
 * trailer) survives. Used to byte-revert in-place edits to **workspace**
 * crates, where the source is committed to the repo and we don't want to
 * leave the markers behind after measurement.
 */
export function revertSourceMarkers(src: string): { content: string; changed: number } {
	const lines = src.split(/(\r?\n)/);
	let changed = 0;
	const out: string[] = [];
	for (let i = 0; i < lines.length; i += 2) {
		const line = lines[i];
		const term = lines[i + 1] ?? "";
		// Match exactly the lines we emit, modulo leading indentation:
		//   `<indent>#[optimize(speed)] // pgo-managed`
		//   `<indent>#[optimize(size)] // pgo-managed`
		if (/^\s*#\[optimize\((?:speed|size)\)\]\s*\/\/\s*pgo-managed\s*$/.test(line)) {
			changed++;
			continue; // drop both the content line and its terminator
		}
		out.push(line, term);
	}
	// `out.join("")` collapses trailing empty entries naturally; no trim
	// needed because join concatenates "" entries to nothing.
	return { content: out.join(""), changed };
}

/**
 * Insert (or update) a `#[optimize(speed|size)]` attribute on every `fn`
 * definition whose identifier matches one of the listed names.
 *
 * The match is anchored on `fn <name>(` or `fn <name><` to allow generic
 * parameter lists. We prepend the attribute on the line above, preserving
 * indentation, and skip lines that already carry our sentinel.
 *
 * We deliberately do NOT try to parse Rust — a full parser is overkill and
 * brittle across editions. The regex matches the syntactic form `fn NAME(`
 * which is unambiguous in idiomatic Rust source. Macro-generated fns and
 * fns whose signature spans multiple lines are handled because we anchor on
 * the line containing `fn NAME(...`.
 */
export function rewriteSource(
	src: string,
	hot: ReadonlySet<string>,
	cold: ReadonlySet<string>
): { content: string; changed: number } {
	if (hot.size === 0 && cold.size === 0) return { content: src, changed: 0 };
	const lines = src.split(/(\r?\n)/);
	let changed = 0;
	// `lines` holds alternating content / line-terminator entries from the
	// split with capturing group; we walk the content cells.
	for (let i = 0; i < lines.length; i += 2) {
		const line = lines[i];
		const m = line.match(/^(\s*)((?:pub(?:\s*\([^)]*\))?\s+)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?(?:extern\s+(?:"[^"]*"\s+)?)?fn\s+)([A-Za-z_][A-Za-z0-9_]*)\s*[<(]/);
		if (!m) continue;
		const [, indent, , name] = m;
		let attr: string | null = null;
		if (hot.has(name)) attr = SPEED_ATTR;
		else if (cold.has(name)) attr = SIZE_ATTR;
		if (!attr) continue;
		// Skip if we already wrote this attribute above the fn.
		const prev = i >= 2 ? lines[i - 2] : "";
		if (prev.includes(ATTR_SENTINEL)) continue;
		// `#[optimize]` is rejected by rustc on:
		//   - required trait methods (declarations without a body)
		//   - extern fn declarations (`extern "C" fn foo();`)
		// Both end the signature with `;` instead of `{`. A signature can
		// span multiple lines (e.g. `fn foo(\n  a: T,\n) -> U;`), so scan
		// forward from this line until we see the first `{` or `;` outside
		// of strings. Lightweight; gives up on very pathological cases.
		if (isDeclarationOnly(lines, i)) continue;
		// Splice the attribute line in. Use the same line ending as line i+1
		// where possible, else "\n".
		const eol = lines[i + 1] ?? "\n";
		lines.splice(i, 0, `${indent}${attr}`, eol);
		changed++;
		i += 2; // skip past the inserted pair
	}
	return { content: lines.join(""), changed };
}

/**
 * Heuristic: starting at `lines[startIdx]` (a content cell containing a
 * `fn NAME(...` opener), look ahead a bounded number of lines and decide
 * whether this fn has a body (`{` first) or is a declaration (`;` first).
 *
 * We don't strip strings/comments — `;` inside a string before the body
 * is rare in idiomatic Rust signatures and would only cause us to skip an
 * unsafe-to-mark fn, never to wrongly mark a declaration.
 */
export function isDeclarationOnly(lines: string[], startIdx: number): boolean {
	// Bound the scan; a fn signature longer than ~40 lines is exotic.
	const limit = Math.min(lines.length, startIdx + 80);
	for (let j = startIdx; j < limit; j += 2) {
		const ln = lines[j];
		// Strip a trailing `// ...` line comment so a stray `;` inside it
		// doesn't fool us. Same for a trailing `/* ... */` if it closes on
		// the same line.
		const noLineComment = ln.replace(/\/\/.*$/, "");
		const noBlockComment = noLineComment.replace(/\/\*.*?\*\//g, "");
		// First "structural" terminator wins.
		const semi = noBlockComment.indexOf(";");
		const brace = noBlockComment.indexOf("{");
		if (semi === -1 && brace === -1) continue;
		if (semi !== -1 && (brace === -1 || semi < brace)) return true;
		return false;
	}
	// Couldn't decide — assume it has a body to avoid silently dropping
	// a real hot fn. (A worst-case false-negative will produce the original
	// rustc error and the user can re-run with a fix.)
	return false;
}

/**
 * Walk a vendored crate directory, apply the plan to every `.rs` file, and
 * write changes in place. Returns per-file change counts plus the total.
 */
export interface ApplyResult {
	files: Array<{ path: string; changes: number }>;
	totalChanges: number;
}

export function applyPlanToVendoredCrate(
	crateDir: string,
	planCrate: PatchPlanCrate,
	io: {
		readFile?: (p: string) => string;
		writeFile?: (p: string, c: string) => void;
		listFiles?: (dir: string) => string[];
	} = {}
): ApplyResult {
	const read = io.readFile ?? ((p) => readFileSync(p, "utf8"));
	const write = io.writeFile ?? ((p, c) => writeFileSync(p, c));
	const list = io.listFiles ?? defaultListRsFiles;

	const hot = new Set(planCrate.hot.map(f => f.fnName));
	const cold = new Set(planCrate.cold.map(f => f.fnName));
	const files: Array<{ path: string; changes: number }> = [];
	let total = 0;
	for (const file of list(crateDir)) {
		const original = read(file);
		let src = original;
		const rel = relative(crateDir, file);
		// Lib root: ensure crate-level header. Common locations.
		const isLibRoot = rel === "src/lib.rs" || rel === join("src", "lib.rs");
		let headerChange = 0;
		if (isLibRoot) {
			const withHeader = ensureLibHeader(src, planCrate.defaultDecision);
			if (withHeader !== src) {
				src = withHeader;
				headerChange = 1;
			}
		}
		const { content, changed } = rewriteSource(src, hot, cold);
		const writeChanges = changed + headerChange;
		if (content !== original) {
			write(file, content);
		}
		if (writeChanges > 0) files.push({ path: file, changes: writeChanges });
		total += writeChanges;
	}
	return { files, totalChanges: total };
}

function defaultListRsFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (d: string): void => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) {
				if (e.name === "target" || e.name === "tests" || e.name === "benches" || e.name === "examples") continue;
				walk(p);
			} else if (e.isFile() && e.name.endsWith(".rs")) {
				out.push(p);
			}
		}
	};
	if (statSync(root).isDirectory()) walk(root);
	return out;
}

/**
 * Reverse `applyPlanToVendoredCrate`. Strips the `// pgo-managed` lib-header
 * block from `src/lib.rs` and removes every per-fn `#[optimize(...)] //
 * pgo-managed` attribute we ever emitted. Used to byte-revert in-place
 * edits to **workspace** crates after measurement, since their source is
 * committed and we don't want to ship the markers (only the tooling).
 */
export function revertWorkspaceCrate(
	crateDir: string,
	io: {
		readFile?: (p: string) => string;
		writeFile?: (p: string, c: string) => void;
		listFiles?: (dir: string) => string[];
	} = {}
): ApplyResult {
	const read = io.readFile ?? ((p) => readFileSync(p, "utf8"));
	const write = io.writeFile ?? ((p, c) => writeFileSync(p, c));
	const list = io.listFiles ?? defaultListRsFiles;

	const files: Array<{ path: string; changes: number }> = [];
	let total = 0;
	for (const file of list(crateDir)) {
		const original = read(file);
		let src = original;
		const rel = relative(crateDir, file);
		const isLibRoot = rel === "src/lib.rs" || rel === join("src", "lib.rs");
		let headerChange = 0;
		if (isLibRoot) {
			const stripped = stripLibHeader(src);
			if (stripped !== src) {
				src = stripped;
				headerChange = 1;
			}
		}
		const { content, changed } = revertSourceMarkers(src);
		const fileChanges = changed + headerChange;
		if (content !== original) {
			write(file, content);
		}
		if (fileChanges > 0) files.push({ path: file, changes: fileChanges });
		total += fileChanges;
	}
	return { files, totalChanges: total };
}

/** Pretty Markdown summary of the plan. */
export function renderPlanMarkdown(plan: PatchPlan): string {
	const out: string[] = [];
	out.push("# PGO cargo-patch plan");
	out.push("");
	out.push(`- Threshold: ${(plan.threshold * 100).toFixed(0)}% cumulative attributable share`);
	out.push(`- Vendor root: \`${plan.vendor_root}\``);
	out.push(`- Crates: **${plan.crates.length}**, hot fns: **${plan.crates.reduce((n, c) => n + c.hot.length, 0)}**, cold fns: **${plan.crates.reduce((n, c) => n + c.cold.length, 0)}**`);
	out.push("");
	out.push("> Default decision is `cold` (size): each patched crate gets a `[profile.release.package.<crate>] opt-level = \"z\"` override in the same managed `[patch.crates-io]` block. Hot fns are bumped back up to speed via `#[optimize(speed)]` (nightly `optimize_attribute`). `#[optimize]` is fn-only — it cannot be applied at the crate root, so the size default has to come from Cargo, not from the lib header.");
	out.push("");
	for (const c of plan.crates) {
		out.push(`## \`${c.crate}\` → \`${c.patchPath}\``);
		out.push("");
		out.push(`Hot (\`#[optimize(speed)]\`):`);
		out.push("");
		for (const f of c.hot) {
			out.push(`- \`${f.fnName}\` — ${(f.pct * 100).toFixed(2)}% (\`${f.symbol}\`)`);
		}
		if (c.hot.length === 0) out.push("- _(none)_");
		out.push("");
		if (c.cold.length > 0) {
			out.push(`Cold (\`#[optimize(size)]\`, kept explicit for clarity):`);
			out.push("");
			for (const f of c.cold) {
				out.push(`- \`${f.fnName}\` — ${(f.pct * 100).toFixed(2)}% (\`${f.symbol}\`)`);
			}
			out.push("");
		}
	}
	return out.join("\n") + "\n";
}
