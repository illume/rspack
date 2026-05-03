// pgo-bench.ts — run the project's existing vitest benchmarks against
// whatever Rust binding is currently installed, persist parseable JSON
// results, and diff two runs (baseline vs candidate variant).
//
// This is the runtime-benchmark counterpart to pgo-profile.ts: it does
// NOT rebuild anything itself — the caller is expected to have already
// produced the variant binding (e.g. via `pgo-run.ts apply --aggressive-size
// && pgo-run.ts rebuild`). Then invoke this to measure runtime, and
// invoke it again on the comparison variant, and `compare` the two.
//
// Why a thin wrapper around the existing `pnpm --filter bench run bench`?
// Because the project already has a curated benchmark surface
// (tests/bench/ts-react.bench.ts + the rstackjs/rspack-benchcases set
// pulled in by `pnpm run bench:prepare`). We don't want to invent a
// second benchmark catalog — we just want a stable JSON shape we can
// diff across release-config variants. vitest's built-in
// `--reporter=json` already gives us per-test mean/hz numbers; we read
// that, normalize, and persist.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const BENCH_SCHEMA_VERSION = 1;

export interface BenchSample {
	/** Test/benchmark name as reported by vitest. */
	name: string;
	/** Mean iteration time in milliseconds (lower = faster). */
	meanMs: number;
	/** Iterations per second (higher = faster). */
	hz: number;
	/** Standard deviation of iteration time, in milliseconds. */
	stdDevMs: number;
	/** Number of samples vitest collected. */
	samples: number;
}

export interface BenchResult {
	schemaVersion: number;
	gitSha: string;
	label: string;
	timestamp: string;
	/** Pre-existing managed-block sentinels at run time, if any. */
	variantHints?: {
		workspaceOptLevel?: string;
		hotCount?: number;
		coldCount?: number;
	};
	samples: BenchSample[];
}

export interface BenchDiffEntry {
	name: string;
	baselineMeanMs: number;
	candidateMeanMs: number;
	deltaPct: number; // negative = candidate faster
	baselineHz: number;
	candidateHz: number;
}

export interface BenchDiff {
	entries: BenchDiffEntry[];
	overallMedianDeltaPct: number;
	overallMeanDeltaPct: number;
}

/**
 * Parse a vitest --reporter=json file into a flat list of BenchSample.
 *
 * vitest's bench JSON shape (as of vitest 3.x): top-level object with a
 * `testResults` array; each entry has `assertionResults` *or* a
 * `benchmark` field with `mean`, `hz`, `sd`, `samples`. Field names
 * vary by vitest minor; we look at the few that have been stable and
 * fall back gracefully.
 */
export function parseVitestBenchJson(raw: string): BenchSample[] {
	const obj = JSON.parse(raw) as unknown;
	const out: BenchSample[] = [];
	const visit = (node: unknown, namePath: string[] = []): void => {
		if (!node || typeof node !== "object") return;
		const n = node as Record<string, unknown>;

		// vitest BenchTaskResult shape: { name, result: { benchmark: { mean, hz, sd, samples } } }
		const benchmark = pickBenchmark(n);
		if (benchmark) {
			const name = [...namePath, asString(n["name"])].filter(Boolean).join(" > ");
			out.push({
				name,
				meanMs: numOr(benchmark.mean, NaN),
				hz: numOr(benchmark.hz, NaN),
				stdDevMs: numOr(benchmark.sd ?? benchmark.stdDev, NaN),
				samples: Math.round(numOr(benchmark.samples, 0)),
			});
			return;
		}

		// Recurse into common containers.
		for (const key of [
			"testResults",
			"tasks",
			"suites",
			"files",
			"children",
			"results",
			"assertionResults",
		]) {
			const v = n[key];
			if (Array.isArray(v)) {
				const childName = asString(n["name"]);
				const next = childName ? [...namePath, childName] : namePath;
				for (const item of v) visit(item, next);
			}
		}
	};
	visit(obj);
	return out;
}

interface RawBenchmark {
	mean?: unknown;
	hz?: unknown;
	sd?: unknown;
	stdDev?: unknown;
	samples?: unknown;
}

function pickBenchmark(n: Record<string, unknown>): RawBenchmark | undefined {
	const direct = n["benchmark"] as Record<string, unknown> | undefined;
	if (direct && typeof direct === "object" && ("mean" in direct || "hz" in direct)) {
		return direct as RawBenchmark;
	}
	const result = n["result"] as Record<string, unknown> | undefined;
	if (result && typeof result === "object") {
		const b = result["benchmark"] as Record<string, unknown> | undefined;
		if (b && ("mean" in b || "hz" in b)) return b as RawBenchmark;
	}
	if ("mean" in n && "hz" in n && "samples" in n) {
		return n as RawBenchmark;
	}
	return undefined;
}

function asString(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function numOr(v: unknown, fallback: number): number {
	const n = typeof v === "number" ? v : Number(v);
	return Number.isFinite(n) ? n : fallback;
}

export function benchResultPath(repoRoot: string, sha: string, label: string): string {
	const safe = label.replace(/[^a-zA-Z0-9._-]+/g, "_");
	return join(repoRoot, "perf_profiles", `bench-${sha}-${safe}.json`);
}

export function writeBenchResult(path: string, result: BenchResult): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
}

export function readBenchResult(path: string): BenchResult {
	const obj = JSON.parse(readFileSync(path, "utf8")) as BenchResult;
	if (obj.schemaVersion !== BENCH_SCHEMA_VERSION) {
		throw new Error(
			`bench schema mismatch: got ${obj.schemaVersion}, want ${BENCH_SCHEMA_VERSION}`
		);
	}
	return obj;
}

/**
 * Diff two BenchResult sets; for each shared benchmark name, compute
 * (candidateMeanMs - baselineMeanMs) / baselineMeanMs * 100. Negative
 * = candidate is faster.
 */
export function compareBenches(
	baseline: BenchResult,
	candidate: BenchResult
): BenchDiff {
	const byName = new Map(baseline.samples.map(s => [s.name, s]));
	const entries: BenchDiffEntry[] = [];
	for (const c of candidate.samples) {
		const b = byName.get(c.name);
		if (!b) continue;
		if (!Number.isFinite(b.meanMs) || !Number.isFinite(c.meanMs) || b.meanMs <= 0) {
			continue;
		}
		entries.push({
			name: c.name,
			baselineMeanMs: b.meanMs,
			candidateMeanMs: c.meanMs,
			deltaPct: ((c.meanMs - b.meanMs) / b.meanMs) * 100,
			baselineHz: b.hz,
			candidateHz: c.hz,
		});
	}
	const deltas = entries.map(e => e.deltaPct);
	const overallMeanDeltaPct =
		deltas.length === 0
			? 0
			: deltas.reduce((a, b) => a + b, 0) / deltas.length;
	const sorted = [...deltas].sort((a, b) => a - b);
	const overallMedianDeltaPct =
		sorted.length === 0
			? 0
			: sorted.length % 2 === 1
				? sorted[(sorted.length - 1) >> 1]
				: (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
	return { entries, overallMedianDeltaPct, overallMeanDeltaPct };
}

export function renderBenchDiffMarkdown(diff: BenchDiff): string {
	const lines: string[] = [];
	lines.push(
		"| Benchmark | Baseline mean (ms) | Candidate mean (ms) | Δ | Baseline hz | Candidate hz |"
	);
	lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
	for (const e of diff.entries) {
		lines.push(
			`| ${e.name} | ${e.baselineMeanMs.toFixed(3)} | ${e.candidateMeanMs.toFixed(3)} | ${e.deltaPct >= 0 ? "+" : ""}${e.deltaPct.toFixed(2)}% | ${e.baselineHz.toFixed(2)} | ${e.candidateHz.toFixed(2)} |`
		);
	}
	lines.push("");
	lines.push(
		`**Overall**: median Δ = ${diff.overallMedianDeltaPct >= 0 ? "+" : ""}${diff.overallMedianDeltaPct.toFixed(2)}%, mean Δ = ${diff.overallMeanDeltaPct >= 0 ? "+" : ""}${diff.overallMeanDeltaPct.toFixed(2)}% (negative = candidate faster).`
	);
	return `${lines.join("\n")}\n`;
}

/**
 * Run the project's existing vitest benchmark via
 * `pnpm --filter bench run bench -- --reporter=json --outputFile=<tmp>`,
 * parse the JSON, and return a BenchResult. Throws on non-zero exit
 * unless `allowEmpty` is set (used by tests).
 */
export interface RunBenchOpts {
	repoRoot: string;
	gitSha: string;
	label: string;
	tmpJsonPath?: string;
	extraArgs?: string[];
	variantHints?: BenchResult["variantHints"];
}

export function runBenchAndCollect(opts: RunBenchOpts): BenchResult {
	const tmp =
		opts.tmpJsonPath ??
		join(opts.repoRoot, "perf_profiles", `_bench-tmp-${Date.now()}.json`);
	mkdirSync(dirname(tmp), { recursive: true });
	const args = [
		"--filter",
		"bench",
		"run",
		"bench",
		"--",
		"--reporter=json",
		`--outputFile=${tmp}`,
		...(opts.extraArgs ?? []),
	];
	const r = spawnSync("pnpm", args, {
		cwd: opts.repoRoot,
		stdio: "inherit",
		env: process.env,
	});
	if (r.status !== 0) {
		throw new Error(`vitest bench exited ${r.status}`);
	}
	if (!existsSync(tmp)) {
		throw new Error(`vitest --outputFile=${tmp} produced no file`);
	}
	const samples = parseVitestBenchJson(readFileSync(tmp, "utf8"));
	const result: BenchResult = {
		schemaVersion: BENCH_SCHEMA_VERSION,
		gitSha: opts.gitSha,
		label: opts.label,
		timestamp: new Date().toISOString(),
		variantHints: opts.variantHints,
		samples,
	};
	return result;
}
