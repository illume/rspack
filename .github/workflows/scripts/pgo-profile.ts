// Profile a Rust binary under `perf record`, parse the resulting
// `perf script` output, attribute samples to crates, and write a versioned
// JSON profile to `perf_profiles/<commit>.json`.
//
// Designed for Node ≥ 22 with native TypeScript support (no compile step).
// All public functions are exported for unit testing; the runner part
// (`record`, `script`, `runProfile`) shells out to `perf` only when invoked
// as a script, so unit tests of the parser do not need perf installed.

import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { argv, env, exit } from "node:process";

export const PROFILE_SCHEMA_VERSION = 1;

export interface SymbolSample {
	symbol: string; // demangled symbol, e.g. "rspack_core::module::Module::build"
	crate: string | null; // attributed crate name, null if unattributable
	samples: number;
}

export interface CrateAggregate {
	crate: string;
	samples: number;
	pct: number; // share of total samples, 0..1
}

export interface PgoProfile {
	schema_version: number;
	git_sha: string;
	created_at: string; // ISO 8601
	rustc_version: string | null;
	command: string; // benchmark command line that was profiled
	total_samples: number;
	by_crate: CrateAggregate[]; // sorted descending by samples
	top_symbols: SymbolSample[]; // top 100, descending
}

/**
 * Extract the crate name from a demangled Rust symbol. The Rust demangler
 * emits crates in two common forms:
 *
 *   - "<crate>::path::to::fn"
 *   - "<<concrete::Type as <crate>::trait::Trait>::method>"
 *
 * For trait-impl symbols we prefer the implementor's crate (the first token
 * before `::`), since perf attribution semantically belongs to the type
 * whose code is being executed.
 *
 * Returns null when no plausible crate prefix is recognizable (e.g. C
 * symbols, anonymous closures starting with `<` without a `::`).
 */
export function crateFromSymbol(sym: string): string | null {
	if (!sym) return null;
	// Strip generic args like `::<T>` and trailing `::{{closure}}` / `::h<hash>`.
	let s = sym;
	// Common kernel / libc symbols: leading "[" (e.g. "[kernel.kallsyms]") or
	// bare lowercase libc names with no `::`.
	if (s.startsWith("[")) return null;

	// Trait-impl form: "<Type as Trait>::method" — pull the implementor.
	if (s.startsWith("<")) {
		const asMatch = s.match(/^<([^ >]+)\s+as\s+/);
		if (asMatch) {
			s = asMatch[1];
		} else {
			// Plain "<Type>::method" — drop the leading `<`.
			s = s.slice(1);
		}
	}
	// A demangled Rust symbol always contains `::` separating the crate
	// from the rest of the path. Bare C/kernel/libc symbols (e.g.
	// `do_syscall_64`, `__schedule`, `_mi_page_malloc_zero`) have no `::`
	// and must be rejected — otherwise we'd emit nonsensical
	// [profile.release.package.<symbol>] overrides for non-crates.
	if (!s.includes("::")) return null;
	const head = s.split("::")[0];
	// A crate name is `[a-zA-Z_][a-zA-Z0-9_]*`. Reject anything else.
	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(head)) return null;
	return head;
}

/**
 * Parse `perf script -F comm,pid,tid,time,event,ip,sym,dso` output and return
 * a map of demangled-symbol → sample count.
 *
 * Each sample header looks like:
 *
 *   rspack_node 12345 12346 [001] 1234.567890:    1 cycles:
 *               0   ffffffff8123abcd rspack_core::module::Module::build+0x12 (.../librspack_node.so)
 *               ...
 *
 * We attribute one sample to the *top* (= leaf) frame of each event header.
 * Inlined / parent frames are kept only as part of stack-trace debug data,
 * not as additional samples (would double-count).
 */
export function parsePerfScript(text: string): Map<string, number> {
	const counts = new Map<string, number>();
	// Split on blank lines, which `perf script` uses to delimit events.
	const events = text.split(/\r?\n\r?\n/);
	for (const ev of events) {
		const lines = ev.split(/\r?\n/).filter(l => l.length > 0);
		if (lines.length < 2) continue;
		// First non-header line (after the "comm pid tid ..." header) is the
		// leaf frame.
		// Frame format: "    <hex-ip> <symbol>+<offset> (<dso>)"
		// We take the symbol up to "+0x..." or " (".
		const leaf = lines[1];
		const m = leaf.match(/^\s+[0-9a-f]+\s+(.+?)(?:\+0x[0-9a-f]+)?\s+\(/i);
		if (!m) continue;
		const sym = m[1].trim();
		counts.set(sym, (counts.get(sym) ?? 0) + 1);
	}
	return counts;
}

/**
 * Aggregate per-symbol sample counts into per-crate totals + percentage,
 * sorted descending. Symbols whose crate cannot be attributed are bucketed
 * under "<unknown>".
 */
export function aggregateByCrate(
	symbolCounts: Map<string, number>
): { byCrate: CrateAggregate[]; totalSamples: number; symbols: SymbolSample[] } {
	let total = 0;
	const crateTotals = new Map<string, number>();
	const symbols: SymbolSample[] = [];
	for (const [sym, n] of symbolCounts) {
		const crate = crateFromSymbol(sym);
		const key = crate ?? "<unknown>";
		crateTotals.set(key, (crateTotals.get(key) ?? 0) + n);
		total += n;
		symbols.push({ symbol: sym, crate, samples: n });
	}
	const byCrate: CrateAggregate[] = [];
	for (const [crate, samples] of crateTotals) {
		byCrate.push({ crate, samples, pct: total === 0 ? 0 : samples / total });
	}
	byCrate.sort((a, b) => b.samples - a.samples);
	symbols.sort((a, b) => b.samples - a.samples);
	return { byCrate, totalSamples: total, symbols };
}

/**
 * Build the on-disk profile JSON. Pure function: takes already-parsed
 * symbol counts plus metadata.
 */
export function buildProfile(opts: {
	symbolCounts: Map<string, number>;
	gitSha: string;
	rustcVersion: string | null;
	command: string;
	createdAt?: string;
	topSymbolsLimit?: number;
}): PgoProfile {
	const { byCrate, totalSamples, symbols } = aggregateByCrate(opts.symbolCounts);
	const topN = opts.topSymbolsLimit ?? 100;
	return {
		schema_version: PROFILE_SCHEMA_VERSION,
		git_sha: opts.gitSha,
		created_at: opts.createdAt ?? new Date().toISOString(),
		rustc_version: opts.rustcVersion,
		command: opts.command,
		total_samples: totalSamples,
		by_crate: byCrate,
		top_symbols: symbols.slice(0, topN),
	};
}

export function profilePath(repoRoot: string, gitSha: string): string {
	return join(repoRoot, "perf_profiles", `${gitSha}.json`);
}

export function writeProfile(path: string, profile: PgoProfile): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(profile, null, 2) + "\n");
}

export function readProfile(path: string): PgoProfile {
	const data = JSON.parse(readFileSync(path, "utf8")) as PgoProfile;
	if (data.schema_version !== PROFILE_SCHEMA_VERSION) {
		throw new Error(
			`profile schema_version ${data.schema_version} != expected ${PROFILE_SCHEMA_VERSION}`
		);
	}
	return data;
}

// --- Runner (only invoked when this file is executed as a script) ---

function getGitSha(repoRoot: string): string {
	return execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
		encoding: "utf8",
	}).trim();
}

function tryRustcVersion(): string | null {
	try {
		return execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim();
	} catch {
		return null;
	}
}

/**
 * Run `perf record` for the given command, then `perf script`. Returns the
 * raw `perf script` text. Throws if perf is not installed.
 */
export function runPerfAndScript(
	cmd: string[],
	cwd: string,
	perfDataPath: string
): string {
	if (cmd.length === 0) throw new Error("empty command");
	const record = spawnSync(
		"perf",
		[
			"record",
			"-F",
			"999",
			"-g",
			"--call-graph",
			"dwarf",
			"-o",
			perfDataPath,
			"--",
			...cmd,
		],
		{ cwd, stdio: "inherit" }
	);
	if (record.status !== 0) {
		throw new Error(`perf record exited ${record.status}`);
	}
	return execFileSync(
		"perf",
		[
			"script",
			"-i",
			perfDataPath,
			"-F",
			"comm,pid,tid,time,event,ip,sym,dso",
		],
		{ cwd, encoding: "utf8", maxBuffer: 1 << 30 }
	);
}

export interface RunProfileOptions {
	repoRoot: string;
	command: string[]; // command to profile, e.g. ["./target/release/bench", "--iters", "10"]
	outPath?: string; // override; default: perf_profiles/<sha>.json
	perfScriptText?: string; // skip perf invocation; parse this text instead (testing)
}

export function runProfile(opts: RunProfileOptions): { path: string; profile: PgoProfile } {
	const sha = getGitSha(opts.repoRoot);
	const perfData = join(opts.repoRoot, "perf_profiles", `${sha}.perf.data`);
	const text =
		opts.perfScriptText ??
		runPerfAndScript(opts.command, opts.repoRoot, perfData);
	const counts = parsePerfScript(text);
	const profile = buildProfile({
		symbolCounts: counts,
		gitSha: sha,
		rustcVersion: tryRustcVersion(),
		command: opts.command.join(" "),
	});
	const out = opts.outPath ?? profilePath(opts.repoRoot, sha);
	writeProfile(out, profile);
	return { path: out, profile };
}

// --- Script entry point ---

function isMain(): boolean {
	const url = import.meta.url;
	return Boolean(argv[1] && url === `file://${argv[1]}`);
}

if (isMain()) {
	const repoRoot = env.REPO_ROOT ?? process.cwd();
	const cmd = argv.slice(2);
	if (cmd.length === 0) {
		console.error(
			"Usage: pgo-profile.ts <command> [args...]  (profiles command under perf)"
		);
		exit(2);
	}
	try {
		const { path } = runProfile({ repoRoot, command: cmd });
		console.log(`wrote ${path}`);
	} catch (e) {
		console.error(`pgo-profile failed: ${(e as Error).message}`);
		exit(1);
	}
}
