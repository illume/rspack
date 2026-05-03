// Function-level (sub-crate) classifier for a stored PGO profile.
//
// `pgo-classify.ts` decides per *crate*: hot crates rebuild at opt-level=3,
// cold crates rebuild at opt-level="z". That's as fine-grained as Cargo
// natively supports — `[profile.release.package.X]` can only target a whole
// package.
//
// Going below the crate is useful because most "hot" crates are 90% cold
// code and 10% hot code: the swc_ecma_minifier in this profile ships ~100
// k symbols but only one (`Pure::visit_mut_expr`) is responsible for 3.49%
// of CPU. Classifying at the function level lets us answer: which specific
// functions deserve `#[inline]` / nightly `#[optimize(speed)]`, and which
// huge cold helpers in otherwise-hot crates can be marked `#[cold]` /
// `#[optimize(size)]`.
//
// This module is pure: input is a parsed PgoProfile, output is a per-symbol
// decision. No I/O. The caller (a future source-rewriting tool, or human
// reviewer) decides what to do with the result. Cargo cannot consume it
// directly — there is no `[profile.release.package.X.function.Y]`.
//
// Algorithm (mirrors the crate-level classifier so behaviour is
// predictable):
//
//   1. Sort top_symbols descending by sample count (already stored that way,
//      but we don't rely on it).
//   2. Drop unattributable symbols (`crate === null` — kernel/libc/JIT) so a
//      large `<unknown>` tail can't make the threshold unreachable. Same
//      treatment as the crate-level classifier.
//   3. Walk the list accumulating share of the *attributable* total; every
//      symbol that contributes share before we cross `hotCumulativeShare`
//      is hot.
//   4. The remaining attributable symbols (and only those — we don't make
//      decisions about symbols outside the recorded top_symbols list) are
//      classified cold.
//
// Note on coverage: PgoProfile.top_symbols only carries the top 100 leaf
// symbols from `perf script`. The long tail (thousands of small functions
// each contributing < 0.1% CPU) doesn't appear here. That's intentional —
// the tail is exactly the bucket where size-optimization always wins, and
// the crate-level classifier already covers it via its `cold` bucket. This
// function-level classifier is for *adding precision inside hot crates*,
// not for replacing the crate-level pass.

import type { PgoProfile, SymbolSample } from "./pgo-profile.ts";

export type FunctionDecision = "hot" | "cold";

export interface FunctionClassifierOptions {
	/**
	 * Cumulative-share threshold for the hot set, in (0, 1]. The smallest
	 * set of top symbols whose summed share of the attributable total
	 * reaches this fraction is marked hot. Default 0.50 — tighter than the
	 * crate-level default (0.85) because a few leaf symbols typically
	 * dominate within each hot crate.
	 */
	hotCumulativeShare?: number;
	/**
	 * Restrict classification to symbols attributed to one of these
	 * crates. When set, symbols outside the set are not returned at all
	 * (typical use: pass the hot crates from the crate-level classifier
	 * to drill into them).
	 */
	restrictToCrates?: readonly string[];
	/**
	 * Symbols (exact match against `SymbolSample.symbol`) explicitly
	 * forced into the hot bucket.
	 */
	alwaysHot?: readonly string[];
	/**
	 * Symbols (exact match against `SymbolSample.symbol`) explicitly
	 * forced into the cold bucket.
	 */
	alwaysCold?: readonly string[];
}

export interface ClassifiedFunction {
	symbol: string;
	crate: string;
	samples: number;
	pct: number; // share of total samples, 0..1
	decision: FunctionDecision;
	reason: string;
	/**
	 * Suggested action a human or source-rewriter should take. These are
	 * hints, not commands — Cargo can't apply them.
	 */
	suggestion: FunctionSuggestion;
}

export type FunctionSuggestion =
	| "annotate-hot" // candidate for #[inline] / nightly #[optimize(speed)]
	| "annotate-cold"; // candidate for #[cold] / nightly #[optimize(size)]

export interface FunctionClassificationResult {
	hot: ClassifiedFunction[];
	cold: ClassifiedFunction[];
	/** Total samples in the profile (denominator for `pct`). */
	totalSamples: number;
	/** Sum of attributable samples actually considered (denominator for cumulative share). */
	consideredSamples: number;
	/** Threshold actually applied. */
	threshold: number;
}

const DEFAULT_HOT_SHARE = 0.5;

export function classifyFunctions(
	profile: PgoProfile,
	opts: FunctionClassifierOptions = {}
): FunctionClassificationResult {
	const share = opts.hotCumulativeShare ?? DEFAULT_HOT_SHARE;
	if (share <= 0 || share > 1) {
		throw new Error(
			`hotCumulativeShare must be in (0, 1], got ${share}`
		);
	}
	const restrict = opts.restrictToCrates
		? new Set(opts.restrictToCrates)
		: null;
	const alwaysHot = new Set(opts.alwaysHot ?? []);
	const alwaysCold = new Set(opts.alwaysCold ?? []);

	const candidates: SymbolSample[] = [...profile.top_symbols]
		.filter((s): s is SymbolSample & { crate: string } => s.crate !== null)
		.filter(s => (restrict ? restrict.has(s.crate as string) : true))
		.sort((a, b) => b.samples - a.samples);

	const consideredSamples = candidates.reduce((n, s) => n + s.samples, 0);
	const norm = consideredSamples > 0 ? consideredSamples : 1;

	const hot: ClassifiedFunction[] = [];
	const cold: ClassifiedFunction[] = [];
	let cumulative = 0;

	for (const s of candidates) {
		const wasUnderThreshold = cumulative < share;
		cumulative += s.samples / norm;
		const forcedHot = alwaysHot.has(s.symbol);
		const forcedCold = alwaysCold.has(s.symbol);
		const decision: FunctionDecision = forcedCold
			? "cold"
			: forcedHot
				? "hot"
				: wasUnderThreshold
					? "hot"
					: "cold";
		const reason = forcedCold
			? "force-cold list"
			: forcedHot
				? "force-hot list"
				: wasUnderThreshold
					? `top symbol (cumulative ≤ ${(share * 100).toFixed(0)}% of attributable)`
					: "below hot-share threshold";
		const entry: ClassifiedFunction = {
			symbol: s.symbol,
			crate: s.crate as string,
			samples: s.samples,
			pct: profile.total_samples > 0 ? s.samples / profile.total_samples : 0,
			decision,
			reason,
			suggestion: decision === "hot" ? "annotate-hot" : "annotate-cold",
		};
		(decision === "hot" ? hot : cold).push(entry);
	}

	return {
		hot,
		cold,
		totalSamples: profile.total_samples,
		consideredSamples,
		threshold: share,
	};
}

/**
 * Render a function-level classification as a human-readable Markdown
 * report. Output is informational — it is *not* something Cargo or rustc
 * can consume directly, by design (see module header).
 */
export function renderFunctionClassification(
	result: FunctionClassificationResult,
	opts: { symbolWidth?: number } = {}
): string {
	const symbolWidth = opts.symbolWidth ?? 120;
	const truncate = (s: string): string =>
		s.length > symbolWidth ? `${s.slice(0, symbolWidth - 1)}…` : s;
	const lines: string[] = [];
	lines.push("# PGO function-level classification");
	lines.push("");
	lines.push(
		`- Threshold: ${(result.threshold * 100).toFixed(0)}% of attributable top-symbol samples`
	);
	lines.push(`- Total samples in profile: ${result.totalSamples}`);
	lines.push(
		`- Symbols considered (attributable, top_symbols): ${result.consideredSamples}`
	);
	lines.push(
		`- Hot (annotate-hot candidates): **${result.hot.length}** functions`
	);
	lines.push(
		`- Cold (annotate-cold candidates): **${result.cold.length}** functions`
	);
	lines.push("");
	lines.push("> Cargo profile overrides are package-level only. Function-");
	lines.push("> level decisions below must be applied by source-level");
	lines.push("> attributes — `#[inline]` / `#[cold]` (stable), or nightly");
	lines.push("> `#![feature(optimize_attribute)]` + `#[optimize(speed|size)]`.");
	lines.push("> For third-party crates this requires vendoring the source.");
	lines.push("");
	lines.push("## Hot (keep at full speed)");
	lines.push("");
	lines.push("| % of total | crate | symbol | suggested annotation |");
	lines.push("| ---: | --- | --- | --- |");
	for (const f of result.hot) {
		lines.push(
			`| ${(f.pct * 100).toFixed(2)}% | \`${f.crate}\` | \`${truncate(f.symbol)}\` | \`#[inline]\` or nightly \`#[optimize(speed)]\` |`
		);
	}
	if (result.hot.length === 0) lines.push("| _(none)_ | | | |");
	lines.push("");
	lines.push("## Cold (compile for size inside otherwise-hot crates)");
	lines.push("");
	lines.push("| % of total | crate | symbol | suggested annotation |");
	lines.push("| ---: | --- | --- | --- |");
	for (const f of result.cold) {
		lines.push(
			`| ${(f.pct * 100).toFixed(2)}% | \`${f.crate}\` | \`${truncate(f.symbol)}\` | \`#[cold]\` or nightly \`#[optimize(size)]\` |`
		);
	}
	if (result.cold.length === 0) lines.push("| _(none)_ | | | |");
	lines.push("");
	return lines.join("\n");
}
