// Render a deeper view of a stored PGO profile: hot functions inside each
// hot crate, plus a top-level "hot functions across the whole binding"
// view.
//
// This is the function-level companion to `pgo-classify.ts` (crate-level).
// The classifier decides per-crate opt-level overrides; this report is an
// aid to humans deciding *within* a hot crate which functions/loops to
// inspect with `perf annotate <symbol>` or to annotate manually with
// `#[inline(always)]` / `#[cold]` / nightly `#[optimize(speed|size)]`.
//
// Pure: input is a parsed PgoProfile, output is a string. No I/O. The
// runner wrapper (the `if (isMain())` block at the bottom) only handles
// reading the profile JSON and printing.

import { readFileSync } from "node:fs";
import { argv, exit } from "node:process";
import type { PgoProfile, SymbolSample } from "./pgo-profile.ts";
import { classify } from "./pgo-classify.ts";
import { readProfile } from "./pgo-profile.ts";

export interface ReportOptions {
	/** Per-crate hot-set threshold (passed through to classify). */
	hotCumulativeShare?: number;
	/** Max functions to show per hot crate. Default 10. */
	functionsPerCrate?: number;
	/** Max global "top hot functions across all crates" rows. Default 25. */
	topGlobalFunctions?: number;
	/** Cap each symbol display to this many chars (perf demangled symbols
	 *  with monomorphisation expansion can be ~500 chars; default 140). */
	symbolWidth?: number;
}

export interface CrateFunctionReport {
	crate: string;
	cratePct: number; // share of total samples attributed to this crate
	functions: Array<{
		symbol: string;
		samples: number;
		pct: number; // share of total samples for the whole binding
		cratePct: number; // share of samples within this crate
	}>;
}

export interface ProfileReport {
	totalSamples: number;
	hotCrates: CrateFunctionReport[];
	globalHotFunctions: Array<{
		symbol: string;
		crate: string | null;
		samples: number;
		pct: number; // share of total
		cumPct: number; // cumulative share of total, in symbol-rank order
	}>;
}

const DEFAULT_FUNCTIONS_PER_CRATE = 10;
const DEFAULT_TOP_GLOBAL = 25;
const DEFAULT_SYMBOL_WIDTH = 140;

/**
 * Build a function-level report from a profile.
 *
 *  - `hotCrates`: for each crate in the classifier's hot bucket, list its
 *    top-N hot functions (ranked by sample count). Useful for "we know
 *    swc_ecma_minifier is hot — *which* functions are hot inside it?"
 *  - `globalHotFunctions`: top-N hot functions across the whole binding
 *    with cumulative share. Useful for "where would 1 hour of human
 *    optimization effort have the biggest impact?"
 */
export function buildReport(
	profile: PgoProfile,
	opts: ReportOptions = {}
): ProfileReport {
	const cls = classify(profile, {
		hotCumulativeShare: opts.hotCumulativeShare,
	});
	const hotSet = new Set(cls.hot.map(c => c.crate));

	// Crate-level totals so we can render each function as a fraction
	// of its parent crate.
	const crateTotals = new Map<string, number>();
	for (const c of profile.by_crate) crateTotals.set(c.crate, c.samples);

	const total = profile.total_samples || 1;
	const symbols = profile.top_symbols;

	const hotCrates: CrateFunctionReport[] = [];
	for (const c of cls.hot) {
		const symsInCrate = symbols
			.filter(s => s.crate === c.crate)
			.slice(0, opts.functionsPerCrate ?? DEFAULT_FUNCTIONS_PER_CRATE);
		const crateTotal = crateTotals.get(c.crate) ?? 0;
		hotCrates.push({
			crate: c.crate,
			cratePct: c.pct,
			functions: symsInCrate.map(s => ({
				symbol: s.symbol,
				samples: s.samples,
				pct: s.samples / total,
				cratePct: crateTotal === 0 ? 0 : s.samples / crateTotal,
			})),
		});
	}

	// Global top-N (by raw samples), with cumulative share. Skip
	// <unknown>-attributed symbols (kernel/libc/JIT) to keep the list
	// actionable for the Rust source tree.
	const globalLimit = opts.topGlobalFunctions ?? DEFAULT_TOP_GLOBAL;
	const filtered = symbols.filter(s => s.crate !== null);
	let cum = 0;
	const globalHotFunctions = filtered.slice(0, globalLimit).map(s => {
		cum += s.samples;
		return {
			symbol: s.symbol,
			crate: s.crate,
			samples: s.samples,
			pct: s.samples / total,
			cumPct: cum / total,
		};
	});
	void hotSet; // (unused; reserved for filtering when caller wants to
	// restrict global list to hot crates only)

	return {
		totalSamples: profile.total_samples,
		hotCrates,
		globalHotFunctions,
	};
}

function trim(s: string, n: number): string {
	if (s.length <= n) return s;
	return s.slice(0, n - 1) + "…";
}

/**
 * Render a `ProfileReport` as a Markdown document. Suitable for posting
 * to PRs or pasting into PGO.md.
 */
export function renderMarkdown(
	report: ProfileReport,
	opts: ReportOptions = {}
): string {
	const w = opts.symbolWidth ?? DEFAULT_SYMBOL_WIDTH;
	const out: string[] = [];
	out.push(`# PGO function-level report`);
	out.push("");
	out.push(`Total samples: \`${report.totalSamples}\`.`);
	out.push("");

	out.push(`## Top hot functions across the whole binding`);
	out.push("");
	out.push(`These are the functions where the binding spends the most CPU time, regardless of crate. Each row is one function; \`cumPct\` is the cumulative share of total samples down the list.`);
	out.push("");
	out.push(`| Rank | Crate | Samples | % | Cum % | Function |`);
	out.push(`| ---: | --- | ---: | ---: | ---: | --- |`);
	report.globalHotFunctions.forEach((f, i) => {
		out.push(
			`| ${i + 1} | \`${f.crate ?? "<unknown>"}\` | ${f.samples} | ${(f.pct * 100).toFixed(2)}% | ${(f.cumPct * 100).toFixed(2)}% | \`${trim(f.symbol, w)}\` |`
		);
	});
	out.push("");

	out.push(`## Hot functions inside each hot crate`);
	out.push("");
	out.push(`For each crate the classifier marked hot, here are its top functions in this profile. Use \`perf annotate <symbol>\` against the same \`perf.data\` to drop into per-instruction (and per-loop) hotspots inside any of these.`);
	out.push("");
	for (const c of report.hotCrates) {
		out.push(`### \`${c.crate}\` — ${(c.cratePct * 100).toFixed(2)}% of total CPU`);
		out.push("");
		if (c.functions.length === 0) {
			out.push(`_No symbols for this crate in the top-100 sample list (crate-level CPU share comes from the long tail)._`);
			out.push("");
			continue;
		}
		out.push(`| Samples | % of binding | % of crate | Function |`);
		out.push(`| ---: | ---: | ---: | --- |`);
		for (const f of c.functions) {
			out.push(
				`| ${f.samples} | ${(f.pct * 100).toFixed(2)}% | ${(f.cratePct * 100).toFixed(2)}% | \`${trim(f.symbol, w)}\` |`
			);
		}
		out.push("");
	}

	out.push(`## Going deeper: per-function loop / instruction view`);
	out.push("");
	out.push(`The profile JSON itself only carries leaf-symbol counts, not per-instruction or per-loop counts. To inspect a specific function's hot loops, run against the same \`perf.data\` that produced this profile:`);
	out.push("");
	out.push(`\`\`\`bash`);
	out.push(`# Source-interleaved disassembly with sample counts per instruction:`);
	out.push(`perf annotate -i perf_profiles/<sha>.perf.data --stdio --source <symbol-substring>`);
	out.push(``);
	out.push(`# TUI flamegraph-equivalent for one symbol:`);
	out.push(`perf report -i perf_profiles/<sha>.perf.data --no-children -s symbol --symbol <symbol-substring>`);
	out.push(`\`\`\``);
	out.push("");
	out.push(`Loops are usually the basic blocks with the highest per-instruction sample density inside the body of one of the functions above. \`perf annotate\` highlights those directly. If you want a flat \`hot loops across the whole binding\` view, run \`perf report --stdio --no-children -s sym,srcline\` on the same \`perf.data\`.`);
	out.push("");

	return out.join("\n");
}

// --- Script entry point ---

function isMain(): boolean {
	const url = import.meta.url;
	return Boolean(argv[1] && url === `file://${argv[1]}`);
}

if (isMain()) {
	const args = argv.slice(2);
	let path: string | undefined;
	const opts: ReportOptions = {};
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--threshold") opts.hotCumulativeShare = Number(args[++i]);
		else if (a === "--functions-per-crate")
			opts.functionsPerCrate = Number(args[++i]);
		else if (a === "--top-global") opts.topGlobalFunctions = Number(args[++i]);
		else if (a === "--symbol-width") opts.symbolWidth = Number(args[++i]);
		else if (a.startsWith("--")) {
			console.error(`unknown flag: ${a}`);
			exit(2);
		} else if (!path) {
			path = a;
		}
	}
	if (!path) {
		console.error(
			"Usage: pgo-report.ts <profile.json> [--threshold N] [--functions-per-crate N] [--top-global N] [--symbol-width N]"
		);
		exit(2);
	}
	const profile = readProfile(path);
	const report = buildReport(profile, opts);
	process.stdout.write(renderMarkdown(report, opts));
}

// Re-export for symmetry with other modules / unit tests.
export type { PgoProfile, SymbolSample };
