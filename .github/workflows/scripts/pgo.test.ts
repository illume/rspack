// Unit tests for the PGO tooling. Pure-function tests only — no perf
// invocation, no real cargo build. Run with:
//
//   node --experimental-strip-types --test .github/workflows/scripts/pgo.test.ts

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	BEGIN_MARKER,
	END_MARKER,
	applyOverridesToFile,
	existingPackageOverrides,
	readWorkspaceReleaseOptLevel,
	removeManagedBlock,
	renderManagedBlock,
	setWorkspaceReleaseOptLevel,
	unsetWorkspaceReleaseOptLevel,
	writeManagedBlock,
} from "./pgo-apply-overrides.ts";
import { classify } from "./pgo-classify.ts";
import { parseApplyOpts } from "./pgo-run.ts";
import {
	PROFILE_SCHEMA_VERSION,
	aggregateByCrate,
	buildProfile,
	crateFromSymbol,
	parsePerfScript,
	readProfile,
	writeProfile,
	type PgoProfile,
} from "./pgo-profile.ts";

// -------- crateFromSymbol --------

describe("crateFromSymbol", () => {
	it("extracts the leading crate from a normal Rust symbol", () => {
		assert.equal(
			crateFromSymbol("rspack_core::module::Module::build"),
			"rspack_core"
		);
		assert.equal(
			crateFromSymbol("swc_ecma_parser::parser::Parser::parse"),
			"swc_ecma_parser"
		);
	});
	it("extracts the implementor's crate from trait-impl symbols", () => {
		assert.equal(
			crateFromSymbol(
				"<rspack_core::compilation::Compilation as rspack_core::Build>::do_build"
			),
			"rspack_core"
		);
		assert.equal(
			crateFromSymbol("<alloc::vec::Vec<T> as core::clone::Clone>::clone"),
			"alloc"
		);
	});
	it("returns null for kernel and unattributable names", () => {
		assert.equal(crateFromSymbol("[kernel.kallsyms]"), null);
		assert.equal(crateFromSymbol(""), null);
		assert.equal(crateFromSymbol("123_not_an_ident"), null);
	});
	it("rejects bare C/kernel/libc symbols (no `::`)", () => {
		// These look like valid identifiers but have no `::`, so they
		// cannot be Rust demangled symbols. Treat as unattributable so
		// we don't emit nonsense [profile.release.package.X] overrides.
		assert.equal(crateFromSymbol("__schedule"), null);
		assert.equal(crateFromSymbol("do_syscall_64"), null);
		assert.equal(crateFromSymbol("_mi_page_malloc_zero"), null);
		assert.equal(crateFromSymbol("clear_page_erms"), null);
		assert.equal(crateFromSymbol("v8"), null);
		assert.equal(crateFromSymbol("node"), null);
	});
	it("handles bracketed-but-no-`as` symbols by stripping the leading `<`", () => {
		assert.equal(crateFromSymbol("<rspack_core::Foo>::bar"), "rspack_core");
	});
});

// -------- parsePerfScript --------

const SAMPLE_PERF_SCRIPT = `\
rspack_node 12345 12346 [001] 1234.567890:    1 cycles:
\t  ffffffff8123abcd rspack_core::module::Module::build+0x12 (/lib/librspack_node.so)
\t  ffffffff8123abce rspack_core::compilation::Compilation::run+0x44 (/lib/librspack_node.so)

rspack_node 12345 12346 [001] 1234.567891:    1 cycles:
\t  ffffffff8123abcd rspack_core::module::Module::build+0x12 (/lib/librspack_node.so)

rspack_node 12345 12346 [001] 1234.567892:    1 cycles:
\t  ffffffff8123ffff swc_ecma_parser::parser::Parser::parse+0x10 (/lib/librspack_node.so)

rspack_node 12345 12346 [001] 1234.567893:    1 cycles:
\t  ffffffff8123aaaa <swc_ecma_codegen::Codegen as swc_ecma_codegen::Emit>::emit+0x4 (/lib/librspack_node.so)

rspack_node 12345 12346 [001] 1234.567894:    1 cycles:
\t  ffffffff8123bbbb [kernel.kallsyms]+0x0 (/proc/kallsyms)
`;

describe("parsePerfScript", () => {
	it("counts one sample per event header (leaf frame)", () => {
		const counts = parsePerfScript(SAMPLE_PERF_SCRIPT);
		assert.equal(counts.get("rspack_core::module::Module::build"), 2);
		assert.equal(counts.get("swc_ecma_parser::parser::Parser::parse"), 1);
		assert.equal(
			counts.get(
				"<swc_ecma_codegen::Codegen as swc_ecma_codegen::Emit>::emit"
			),
			1
		);
		assert.equal(counts.get("[kernel.kallsyms]"), 1);
		// The non-leaf frame (Compilation::run) must NOT be counted as a sample.
		assert.equal(counts.has("rspack_core::compilation::Compilation::run"), false);
	});
	it("tolerates CRLF line endings", () => {
		const crlf = SAMPLE_PERF_SCRIPT.replace(/\n/g, "\r\n");
		const counts = parsePerfScript(crlf);
		assert.equal(counts.get("rspack_core::module::Module::build"), 2);
	});
	it("returns empty on empty input", () => {
		assert.equal(parsePerfScript("").size, 0);
	});
});

// -------- aggregateByCrate --------

describe("aggregateByCrate", () => {
	it("groups symbols by crate and computes percentages", () => {
		const counts = new Map<string, number>([
			["rspack_core::a::b", 7],
			["rspack_core::c::d", 3],
			["swc_ecma_parser::e", 5],
			["[kernel.kallsyms]", 5],
		]);
		const { byCrate, totalSamples } = aggregateByCrate(counts);
		assert.equal(totalSamples, 20);
		assert.equal(byCrate[0].crate, "rspack_core");
		assert.equal(byCrate[0].samples, 10);
		assert.ok(Math.abs(byCrate[0].pct - 0.5) < 1e-9);
		const unk = byCrate.find(c => c.crate === "<unknown>");
		assert.ok(unk, "kernel symbol should be bucketed under <unknown>");
		assert.equal(unk!.samples, 5);
	});
});

// -------- buildProfile / writeProfile / readProfile round-trip --------

describe("profile round-trip", () => {
	it("writes and reads a self-describing JSON", () => {
		const counts = parsePerfScript(SAMPLE_PERF_SCRIPT);
		const profile = buildProfile({
			symbolCounts: counts,
			gitSha: "deadbeef",
			rustcVersion: "rustc 1.99.0",
			command: "./bench --iters 10",
			createdAt: "2026-05-03T12:00:00.000Z",
		});
		assert.equal(profile.schema_version, PROFILE_SCHEMA_VERSION);
		assert.equal(profile.git_sha, "deadbeef");
		assert.equal(profile.command, "./bench --iters 10");
		assert.ok(profile.total_samples > 0);

		const dir = mkdtempSync(join(tmpdir(), "pgo-test-"));
		const path = join(dir, "profile.json");
		writeProfile(path, profile);
		const round = readProfile(path);
		assert.deepEqual(round, profile);
	});
	it("rejects an unknown schema_version", () => {
		const dir = mkdtempSync(join(tmpdir(), "pgo-test-"));
		const path = join(dir, "bad.json");
		writeFileSync(path, JSON.stringify({ schema_version: 999 }));
		assert.throws(() => readProfile(path), /schema_version 999/);
	});
});

// -------- classify --------

function makeProfile(crates: Array<[string, number]>): PgoProfile {
	const total = crates.reduce((s, [, n]) => s + n, 0);
	return {
		schema_version: PROFILE_SCHEMA_VERSION,
		git_sha: "x",
		created_at: "2026-05-03T00:00:00.000Z",
		rustc_version: null,
		command: "test",
		total_samples: total,
		by_crate: crates.map(([crate, samples]) => ({
			crate,
			samples,
			pct: samples / total,
		})),
		top_symbols: [],
	};
}

describe("classify", () => {
	it("marks crates that fill the cumulative-share threshold as hot", () => {
		const p = makeProfile([
			["rspack_core", 60],
			["swc_parser", 20],
			["regex", 10],
			["nu_ansi_term", 5],
			["owo_colors", 5],
		]);
		const r = classify(p, { hotCumulativeShare: 0.85 });
		const hotNames = r.hot.map(c => c.crate);
		// rspack_core (cumulative 0.00 → 0.60), swc_parser (0.60 → 0.80), and
		// regex (0.80 → 0.90) are each evaluated when the *prior* cumulative
		// share was still < 0.85, so all three end up hot. nu_ansi_term
		// (cumulative 0.90 at decision time) is the first to fall below the
		// threshold and is cold.
		assert.deepEqual(hotNames, ["rspack_core", "swc_parser", "regex"]);
		const coldNames = r.cold.map(c => c.crate);
		assert.deepEqual(coldNames, ["nu_ansi_term", "owo_colors"]);
	});
	it("excludes <unknown> from classification", () => {
		const p = makeProfile([
			["rspack_core", 50],
			["<unknown>", 50],
		]);
		const r = classify(p);
		assert.deepEqual(r.hot.map(c => c.crate), ["rspack_core"]);
		assert.equal(r.cold.length, 0);
	});
	it("alwaysHot / alwaysCold override the heuristic", () => {
		const p = makeProfile([
			["rspack_core", 90],
			["nu_ansi_term", 10],
		]);
		const r = classify(p, {
			alwaysHot: ["nu_ansi_term"],
			alwaysCold: ["rspack_core"],
		});
		assert.deepEqual(r.hot.map(c => c.crate), ["nu_ansi_term"]);
		assert.deepEqual(r.cold.map(c => c.crate), ["rspack_core"]);
	});
	it("candidates default to cold when not seen in the profile", () => {
		const p = makeProfile([["rspack_core", 100]]);
		const r = classify(p, { candidates: ["unseen_crate"] });
		assert.ok(r.cold.find(c => c.crate === "unseen_crate"));
	});
	it("rejects out-of-range thresholds", () => {
		const p = makeProfile([["a", 1]]);
		assert.throws(() => classify(p, { hotCumulativeShare: 0 }));
		assert.throws(() => classify(p, { hotCumulativeShare: 1.5 }));
	});
});

// -------- parseApplyOpts (CLI flag wiring) --------

describe("parseApplyOpts", () => {
	it("parses --always-hot / --always-cold as comma-separated lists", () => {
		const { opts } = parseApplyOpts([
			"--always-hot", "rspack_core,rspack_napi",
			"--always-cold", "miette",
		]);
		assert.deepEqual(opts.alwaysHot, ["rspack_core", "rspack_napi"]);
		assert.deepEqual(opts.alwaysCold, ["miette"]);
	});
	it("accumulates repeated --always-hot flags and trims whitespace", () => {
		const { opts } = parseApplyOpts([
			"--always-hot", " rspack_core , rspack_napi ",
			"--always-hot", "rspack_resolver",
		]);
		assert.deepEqual(opts.alwaysHot, [
			"rspack_core", "rspack_napi", "rspack_resolver",
		]);
	});
	it("--aggressive-size composes with --always-hot", () => {
		const { opts } = parseApplyOpts([
			"--aggressive-size",
			"--always-hot", "rspack_core",
		]);
		assert.equal(opts.workspaceDefault, "z");
		assert.equal(opts.hotOptLevel, "3");
		assert.deepEqual(opts.alwaysHot, ["rspack_core"]);
	});
});

// -------- renderManagedBlock / writeManagedBlock --------

const MINI_CARGO = `\
[workspace]
members = []

[profile.release]
codegen-units = 1
lto       = "fat"
opt-level = 3
panic     = "abort"

[profile.release.package.regex-syntax]
opt-level = "s"
`;

describe("readWorkspaceReleaseOptLevel", () => {
	it("recognizes double-quoted, single-quoted, and bare-token forms", () => {
		const dq = MINI_CARGO; // `opt-level = 3`
		assert.equal(readWorkspaceReleaseOptLevel(dq), "3");
		assert.equal(
			readWorkspaceReleaseOptLevel(MINI_CARGO.replace("opt-level = 3", 'opt-level = "s"')),
			"s"
		);
		assert.equal(
			readWorkspaceReleaseOptLevel(MINI_CARGO.replace("opt-level = 3", "opt-level = 's'")),
			"s"
		);
	});
	it("returns '3' as default when the section or key is missing", () => {
		assert.equal(readWorkspaceReleaseOptLevel("[workspace]\nmembers = []\n[a]\n"), "3");
		const noKey = MINI_CARGO.replace(/^opt-level = 3\n/m, "");
		assert.equal(readWorkspaceReleaseOptLevel(noKey), "3");
	});
});

describe("renderManagedBlock", () => {
	it("emits cold-crate overrides and skips hot when default == 3", () => {
		const block = renderManagedBlock(
			{
				hot: [{ crate: "rspack_core", decision: "hot", samples: 100, pct: 0.5, reason: "r" }],
				cold: [{ crate: "nu_ansi_term", decision: "cold", samples: 1, pct: 0.01, reason: "r" }],
			},
			MINI_CARGO
		);
		assert.match(block, new RegExp(BEGIN_MARKER));
		assert.match(block, new RegExp(END_MARKER));
		// Hot is omitted — workspace already at opt-level=3.
		assert.equal(/\[profile\.release\.package\.rspack_core\]/.test(block), false);
		assert.match(block, /\[profile\.release\.package\.nu_ansi_term\]/);
		assert.match(block, /opt-level = "z"/);
	});
	it("emits hot overrides when workspace default has been flipped to s", () => {
		const flipped = MINI_CARGO.replace("opt-level = 3", 'opt-level = "s"');
		assert.equal(readWorkspaceReleaseOptLevel(flipped), "s");
		const block = renderManagedBlock(
			{
				hot: [{ crate: "rspack_core", decision: "hot", samples: 100, pct: 0.5, reason: "r" }],
				cold: [],
			},
			flipped
		);
		assert.match(block, /\[profile\.release\.package\.rspack_core\]/);
		assert.match(block, /opt-level = 3/);
	});
	it("renders an explicit empty marker when nothing differs from default", () => {
		const block = renderManagedBlock({ hot: [], cold: [] }, MINI_CARGO);
		assert.match(block, /no overrides needed/);
	});
	it("skips crates that already have a hand-written [profile.release.package.X] override", () => {
		// MINI_CARGO already pins `regex-syntax`. Re-emitting it from the
		// managed block would produce a TOML duplicate-key error and break
		// `cargo metadata`. The renderer must skip it.
		const block = renderManagedBlock(
			{
				hot: [],
				cold: [
					{ crate: "regex-syntax", decision: "cold", samples: 1, pct: 0.01, reason: "r" },
					{ crate: "owo_colors", decision: "cold", samples: 1, pct: 0.01, reason: "r" },
				],
			},
			MINI_CARGO
		);
		assert.equal(
			/\[profile\.release\.package\.regex-syntax\]/.test(
				block.replace(/^# .*$/gm, "")
			),
			false,
			"existing override must not be re-emitted"
		);
		assert.match(block, /\[profile\.release\.package\.owo_colors\]/);
		assert.match(block, /Skipped 1 crate/);
	});
});

describe("existingPackageOverrides", () => {
	it("collects bare and quoted override keys, ignoring the managed block", () => {
		const cargo =
			MINI_CARGO +
			"\n" +
			BEGIN_MARKER +
			"\n[profile.release.package.from_managed]\nopt-level = \"z\"\n" +
			END_MARKER +
			"\n[profile.release.package.\"crate-with-dash\"]\nopt-level = \"s\"\n";
		const set = existingPackageOverrides(cargo);
		assert.equal(set.has("regex-syntax"), true);
		assert.equal(set.has("crate-with-dash"), true);
		assert.equal(set.has("from_managed"), false, "managed block must be ignored");
	});
});

describe("writeManagedBlock & removeManagedBlock", () => {
	it("appends the block on first apply and replaces on subsequent applies", () => {
		const block1 = renderManagedBlock(
			{
				hot: [],
				cold: [{ crate: "owo_colors", decision: "cold", samples: 1, pct: 0.001, reason: "r" }],
			},
			MINI_CARGO
		);
		const after1 = writeManagedBlock(MINI_CARGO, block1);
		assert.match(after1, /owo_colors/);
		// Pre-existing manual override is untouched.
		assert.match(after1, /\[profile\.release\.package\.regex-syntax\]/);

		const block2 = renderManagedBlock(
			{
				hot: [],
				cold: [{ crate: "nu_ansi_term", decision: "cold", samples: 1, pct: 0.001, reason: "r" }],
			},
			MINI_CARGO
		);
		const after2 = writeManagedBlock(after1, block2);
		assert.equal(after2.includes("owo_colors"), false, "old block should be replaced");
		assert.match(after2, /nu_ansi_term/);
		// Only one managed block at a time.
		const matches = after2.match(new RegExp(BEGIN_MARKER, "g"));
		assert.equal(matches!.length, 1);
	});
	it("removeManagedBlock strips the block and leaves manual overrides intact", () => {
		const block = renderManagedBlock(
			{
				hot: [],
				cold: [{ crate: "owo_colors", decision: "cold", samples: 1, pct: 0.001, reason: "r" }],
			},
			MINI_CARGO
		);
		const withBlock = writeManagedBlock(MINI_CARGO, block);
		const reverted = removeManagedBlock(withBlock);
		assert.equal(reverted.includes(BEGIN_MARKER), false);
		assert.equal(reverted.includes("owo_colors"), false);
		assert.match(reverted, /\[profile\.release\.package\.regex-syntax\]/);
		// Round-trip apply→revert must restore byte-for-byte.
		assert.equal(reverted, MINI_CARGO, "revert should restore original content");
	});
});

// -------- applyOverridesToFile (file-level) --------

describe("applyOverridesToFile", () => {
	it("writes to disk and reports changed", () => {
		const dir = mkdtempSync(join(tmpdir(), "pgo-cargo-"));
		const file = join(dir, "Cargo.toml");
		writeFileSync(file, MINI_CARGO);
		const r = applyOverridesToFile(file, {
			hot: [],
			cold: [{ crate: "x", decision: "cold", samples: 1, pct: 0.01, reason: "r" }],
		});
		assert.equal(r.changed, true);
		const after = readFileSync(file, "utf8");
		assert.match(after, /\[profile\.release\.package\.x\]/);
		// Idempotent: applying the same input again should be a no-op.
		const r2 = applyOverridesToFile(file, {
			hot: [],
			cold: [{ crate: "x", decision: "cold", samples: 1, pct: 0.01, reason: "r" }],
		});
		assert.equal(r2.changed, false);
	});
});

// -------- pgo-report (function-level) --------

import { buildReport, renderMarkdown } from "./pgo-report.ts";

function reportFixture(): PgoProfile {
// Two clearly-hot crates and one cold one. swc_ecma_minifier dominates.
return {
schema_version: PROFILE_SCHEMA_VERSION,
git_sha: "abc",
created_at: "2026-01-01T00:00:00Z",
rustc_version: null,
command: "fixture",
total_samples: 1000,
by_crate: [
{ crate: "swc_ecma_minifier", samples: 700, pct: 0.7 },
{ crate: "swc_ecma_parser", samples: 200, pct: 0.2 },
{ crate: "log", samples: 50, pct: 0.05 },
{ crate: "<unknown>", samples: 50, pct: 0.05 },
],
top_symbols: [
{ symbol: "<swc_ecma_minifier::Pure>::visit_mut_expr", crate: "swc_ecma_minifier", samples: 400 },
{ symbol: "<swc_ecma_minifier::Optimizer>::visit_mut_expr", crate: "swc_ecma_minifier", samples: 200 },
{ symbol: "<swc_ecma_minifier::Pure>::make_bool", crate: "swc_ecma_minifier", samples: 100 },
{ symbol: "<swc_ecma_parser::Lexer>::next_token", crate: "swc_ecma_parser", samples: 150 },
{ symbol: "<swc_ecma_parser::Lexer>::read_keyword", crate: "swc_ecma_parser", samples: 50 },
{ symbol: "log::log", crate: "log", samples: 50 },
{ symbol: "do_syscall_64", crate: null, samples: 50 },
],
};
}

describe("buildReport", () => {
it("includes top functions for every hot crate", () => {
const profile = reportFixture();
const r = buildReport(profile, { hotCumulativeShare: 0.85 });
const minifier = r.hotCrates.find(c => c.crate === "swc_ecma_minifier");
assert.ok(minifier, "minifier should be hot");
assert.equal(minifier!.functions.length, 3);
// Within-crate share: 400/700 ≈ 0.5714
assert.ok(
Math.abs(minifier!.functions[0].cratePct - 400 / 700) < 1e-9,
`expected cratePct ~${400 / 700}, got ${minifier!.functions[0].cratePct}`
);
// Whole-binding share: 400/1000 = 0.4
assert.equal(minifier!.functions[0].pct, 0.4);
});
it("respects functionsPerCrate cap", () => {
const r = buildReport(reportFixture(), { functionsPerCrate: 1 });
const minifier = r.hotCrates.find(c => c.crate === "swc_ecma_minifier")!;
assert.equal(minifier.functions.length, 1);
assert.match(minifier.functions[0].symbol, /Pure>::visit_mut_expr/);
});
it("excludes <unknown>-attributed symbols from globalHotFunctions", () => {
const r = buildReport(reportFixture());
assert.ok(r.globalHotFunctions.every(f => f.crate !== null));
// And kernel/libc symbol is gone
assert.ok(!r.globalHotFunctions.some(f => f.symbol === "do_syscall_64"));
});
it("computes monotonically nondecreasing cumPct for global functions", () => {
const r = buildReport(reportFixture());
let prev = 0;
for (const f of r.globalHotFunctions) {
assert.ok(f.cumPct >= prev - 1e-12, `cumPct went down: ${prev} -> ${f.cumPct}`);
assert.ok(f.cumPct <= 1 + 1e-12, `cumPct > 1: ${f.cumPct}`);
prev = f.cumPct;
}
});
});

describe("renderMarkdown", () => {
it("renders the hot-crate sections and the loop-inspection recipe", () => {
const md = renderMarkdown(buildReport(reportFixture()));
assert.match(md, /Top hot functions across the whole binding/);
assert.match(md, /Hot functions inside each hot crate/);
assert.match(md, /### `swc_ecma_minifier`/);
assert.match(md, /perf annotate/);
assert.match(md, /perf report/);
});
it("trims long symbol names to the requested width", () => {
const wide = "a".repeat(500);
const profile: PgoProfile = {
...reportFixture(),
top_symbols: [
{ symbol: `swc_ecma_minifier::${wide}`, crate: "swc_ecma_minifier", samples: 700 },
],
};
const md = renderMarkdown(buildReport(profile), { symbolWidth: 50 });
// The truncation marker should appear and no row should be 500+ chars long.
assert.match(md, /…/);
for (const line of md.split("\n")) {
assert.ok(line.length < 400, `line too long: ${line.length}`);
}
});
});

// -------- classifyFunctions (sub-crate, function-level) --------

import {
classifyFunctions,
renderFunctionClassification,
} from "./pgo-classify-functions.ts";

function fnFixture(): PgoProfile {
return {
schema_version: PROFILE_SCHEMA_VERSION,
git_sha: "f".repeat(40),
created_at: "2026-05-03T00:00:00.000Z",
rustc_version: "rustc 1.97.0-nightly",
command: "fn-fixture",
total_samples: 1000,
by_crate: [],
top_symbols: [
// 600 samples = 60% of total, but only 60% of the *attributable* 1000 if all are attributed.
{ symbol: "swc_ecma_minifier::Pure::visit_mut_expr", crate: "swc_ecma_minifier", samples: 600 },
{ symbol: "hstr::Atom::eq", crate: "hstr", samples: 200 },
{ symbol: "swc_ecma_parser::lex::next_token", crate: "swc_ecma_parser", samples: 100 },
{ symbol: "small::cold::helper", crate: "swc_ecma_minifier", samples: 50 },
// Unattributable kernel symbol — must be ignored.
{ symbol: "_mi_page_malloc_zero", crate: null, samples: 200 },
],
};
}

describe("classifyFunctions", () => {
it("marks the smallest top set covering >= threshold of attributable as hot", () => {
const r = classifyFunctions(fnFixture(), { hotCumulativeShare: 0.5 });
// Attributable total = 600+200+100+50 = 950. 50% = 475. The first
// symbol (600) crosses the threshold by itself.
assert.equal(r.hot.length, 1);
assert.equal(r.hot[0].symbol, "swc_ecma_minifier::Pure::visit_mut_expr");
assert.equal(r.cold.length, 3);
assert.equal(r.consideredSamples, 950);
});
it("ignores unattributable symbols (kernel/libc) entirely", () => {
const r = classifyFunctions(fnFixture(), { hotCumulativeShare: 0.99 });
const allSymbols = [...r.hot, ...r.cold].map(f => f.symbol);
assert.ok(!allSymbols.includes("_mi_page_malloc_zero"));
});
it("respects restrictToCrates by dropping symbols outside the set", () => {
const r = classifyFunctions(fnFixture(), {
hotCumulativeShare: 0.5,
restrictToCrates: ["swc_ecma_minifier"],
});
const crates = new Set([...r.hot, ...r.cold].map(f => f.crate));
assert.deepEqual([...crates], ["swc_ecma_minifier"]);
});
it("honours alwaysHot / alwaysCold overrides", () => {
const r = classifyFunctions(fnFixture(), {
hotCumulativeShare: 0.5,
alwaysHot: ["swc_ecma_parser::lex::next_token"],
alwaysCold: ["swc_ecma_minifier::Pure::visit_mut_expr"],
});
const next = [...r.hot, ...r.cold].find(
f => f.symbol === "swc_ecma_parser::lex::next_token"
);
const pure = [...r.hot, ...r.cold].find(
f => f.symbol === "swc_ecma_minifier::Pure::visit_mut_expr"
);
assert.equal(next?.decision, "hot");
assert.equal(pure?.decision, "cold");
});
it("rejects threshold outside (0, 1]", () => {
assert.throws(() => classifyFunctions(fnFixture(), { hotCumulativeShare: 0 }));
assert.throws(() => classifyFunctions(fnFixture(), { hotCumulativeShare: 1.5 }));
});
it("renderFunctionClassification produces a markdown report with hot and cold tables", () => {
const r = classifyFunctions(fnFixture(), { hotCumulativeShare: 0.5 });
const md = renderFunctionClassification(r);
assert.match(md, /## Hot/);
assert.match(md, /## Cold/);
assert.match(md, /optimize\(speed\)/);
assert.match(md, /optimize\(size\)/);
assert.match(md, /Pure::visit_mut_expr/);
});
});

// -------- setWorkspaceReleaseOptLevel / unsetWorkspaceReleaseOptLevel --------

describe("setWorkspaceReleaseOptLevel / unsetWorkspaceReleaseOptLevel", () => {
const sample = `[workspace]
members = ["a"]

[profile.release]
codegen-units = 1
lto = "fat"
opt-level = 3
strip = true

[profile.release.package.regex-syntax]
opt-level = "s"
`;

it("rewrites bare-numeric opt-level to a quoted string and tags the original", () => {
const after = setWorkspaceReleaseOptLevel(sample, "z");
assert.match(after, /opt-level = "z" *# pgo-managed-original-opt-level=3/);
assert.equal(readWorkspaceReleaseOptLevel(after), "z");
});

it("revert restores the original byte-for-byte", () => {
const flipped = setWorkspaceReleaseOptLevel(sample, "z");
const reverted = unsetWorkspaceReleaseOptLevel(flipped);
assert.equal(reverted, sample);
});

it("idempotent set: the original value is preserved across re-runs", () => {
const a = setWorkspaceReleaseOptLevel(sample, "z");
const b = setWorkspaceReleaseOptLevel(a, "s");
// re-running with a different level should keep the *original* "3"
// in the sentinel, not "z".
assert.match(b, /pgo-managed-original-opt-level=3/);
assert.equal(readWorkspaceReleaseOptLevel(b), "s");
const reverted = unsetWorkspaceReleaseOptLevel(b);
assert.equal(reverted, sample);
});

it("preserves CRLF line endings (Windows checkout)", () => {
const crlf = sample.replace(/\n/g, "\r\n");
const flipped = setWorkspaceReleaseOptLevel(crlf, "z");
assert.ok(flipped.includes("\r\n"));
const reverted = unsetWorkspaceReleaseOptLevel(flipped);
assert.equal(reverted, crlf);
});

it("unset is a no-op when no sentinel is present", () => {
assert.equal(unsetWorkspaceReleaseOptLevel(sample), sample);
});

it("does nothing when there is no [profile.release] section", () => {
const noProfile = `[workspace]\nmembers = ["a"]\n\n[other]\nx = 1\n`;
assert.equal(setWorkspaceReleaseOptLevel(noProfile, "z"), noProfile);
});
});

import {
BENCH_SCHEMA_VERSION,
compareBenches,
parseVitestBenchJson,
parseVitestBenchStdout,
readBenchResult,
renderBenchDiffMarkdown,
writeBenchResult,
type BenchResult,
} from "./pgo-bench.ts";

describe("pgo-bench: parseVitestBenchStdout", () => {
it("extracts mean(ms), hz, samples from the human-readable bench table", () => {
const stdout = [
" ✓ ts-react.bench.ts > TypeScript React project 5837ms",
"     name                                              hz     min      max    mean     p75     p99     p995     p999      rme  samples",
"   · js@Traverse module graph by dependencies    7,023.11  0.1177   1.8537  0.1424  0.1412  0.2549   0.2631   0.2884   ±0.95%     3512",
"   · js@stats.toJson()                             225.36  3.6120  10.6489  4.4374  4.8380  7.5333  10.6489  10.6489   ±4.64%      113",
].join("\n");
const samples = parseVitestBenchStdout(stdout);
assert.equal(samples.length, 2);
const a = samples[0];
assert.equal(a.name, "js@Traverse module graph by dependencies");
assert.ok(Math.abs(a.hz - 7023.11) < 1e-6);
assert.ok(Math.abs(a.meanMs - 0.1424) < 1e-9);
assert.equal(a.samples, 3512);
const b = samples[1];
assert.equal(b.name, "js@stats.toJson()");
assert.ok(Math.abs(b.meanMs - 4.4374) < 1e-9);
assert.equal(b.samples, 113);
});

it("returns empty array on non-bench stdout", () => {
assert.deepEqual(parseVitestBenchStdout("hello\nworld\n"), []);
assert.deepEqual(parseVitestBenchStdout(""), []);
});

it("strips ANSI color codes from vitest reporter output", () => {
const ansi = "   \u001b[32m·\u001b[39m js@bench    \u001b[34m  7,011.50\u001b[39m  \u001b[36m0.1171\u001b[39m  \u001b[36m 2.0555\u001b[39m  \u001b[36m0.1426\u001b[39m  \u001b[36m0.1419\u001b[39m  \u001b[36m0.2630\u001b[39m  \u001b[36m0.2719\u001b[39m  \u001b[36m0.3423\u001b[39m  \u001b[33m±1.04%\u001b[39m     3506";
const samples = parseVitestBenchStdout(ansi);
assert.equal(samples.length, 1);
assert.equal(samples[0].name, "js@bench");
assert.ok(Math.abs(samples[0].meanMs - 0.1426) < 1e-9);
assert.equal(samples[0].samples, 3506);
});
});

describe("pgo-bench: parseVitestBenchJson", () => {
it("parses vitest 3.x BenchTaskResult shape with nested tasks", () => {
const raw = JSON.stringify({
tasks: [
{
name: "ts-react.bench.ts",
tasks: [
{
name: "build",
result: {
benchmark: { mean: 12.5, hz: 80, sd: 0.4, samples: 10 },
},
},
{
name: "rebuild",
result: {
benchmark: { mean: 5.25, hz: 190.5, sd: 0.12, samples: 12 },
},
},
],
},
],
});
const samples = parseVitestBenchJson(raw);
assert.equal(samples.length, 2);
const build = samples.find(s => s.name.endsWith("build"));
assert.ok(build);
assert.equal(build!.meanMs, 12.5);
assert.equal(build!.hz, 80);
assert.equal(build!.stdDevMs, 0.4);
assert.equal(build!.samples, 10);
});

it("falls back to direct mean/hz/samples on a leaf", () => {
const raw = JSON.stringify({
tasks: [{ name: "x", mean: 1.5, hz: 666, samples: 3, sd: 0.01 }],
});
const samples = parseVitestBenchJson(raw);
assert.equal(samples.length, 1);
assert.equal(samples[0].meanMs, 1.5);
});

it("returns empty array for non-bench shapes", () => {
assert.deepEqual(parseVitestBenchJson("{}"), []);
assert.deepEqual(parseVitestBenchJson('{"tasks":[]}'), []);
});
});

describe("pgo-bench: compareBenches", () => {
const baseline: BenchResult = {
schemaVersion: BENCH_SCHEMA_VERSION,
gitSha: "aaa",
label: "baseline",
timestamp: "t0",
samples: [
{ name: "build", meanMs: 100, hz: 10, stdDevMs: 1, samples: 5 },
{ name: "rebuild", meanMs: 50, hz: 20, stdDevMs: 0.5, samples: 5 },
{ name: "only-baseline", meanMs: 1, hz: 1000, stdDevMs: 0, samples: 5 },
],
};
const candidate: BenchResult = {
schemaVersion: BENCH_SCHEMA_VERSION,
gitSha: "bbb",
label: "aggressive-z",
timestamp: "t1",
samples: [
{ name: "build", meanMs: 110, hz: 9.09, stdDevMs: 1, samples: 5 },
{ name: "rebuild", meanMs: 45, hz: 22.22, stdDevMs: 0.4, samples: 5 },
{ name: "only-candidate", meanMs: 1, hz: 1000, stdDevMs: 0, samples: 5 },
],
};

it("computes signed deltaPct only for shared benchmark names", () => {
const diff = compareBenches(baseline, candidate);
assert.equal(diff.entries.length, 2);
const build = diff.entries.find(e => e.name === "build");
assert.ok(build);
assert.ok(Math.abs(build!.deltaPct - 10) < 1e-9);
const rebuild = diff.entries.find(e => e.name === "rebuild");
assert.ok(rebuild);
assert.ok(Math.abs(rebuild!.deltaPct - -10) < 1e-9);
});

it("median delta picks the middle of an even-length sorted list", () => {
const diff = compareBenches(baseline, candidate);
// deltas = [+10, -10] sorted = [-10, +10] → median = 0
assert.ok(Math.abs(diff.overallMedianDeltaPct) < 1e-9);
});

it("renders a stable markdown table with sign-prefixed deltas", () => {
const md = renderBenchDiffMarkdown(compareBenches(baseline, candidate));
assert.match(md, /\| Benchmark \|/);
assert.match(md, /\+10\.00%/);
assert.match(md, /-10\.00%/);
});

it("rejects zero-mean baseline rows (avoids divide-by-zero)", () => {
const zero: BenchResult = {
...baseline,
samples: [{ name: "build", meanMs: 0, hz: 0, stdDevMs: 0, samples: 5 }],
};
const diff = compareBenches(zero, candidate);
assert.equal(diff.entries.length, 0);
});
});

describe("pgo-bench: writeBenchResult / readBenchResult", () => {
it("round-trips and rejects schema-version mismatch", () => {
const dir = mkdtempSync(join(tmpdir(), "pgo-bench-"));
const path = join(dir, "bench-x.json");
const r: BenchResult = {
schemaVersion: BENCH_SCHEMA_VERSION,
gitSha: "c",
label: "x",
timestamp: "t",
samples: [{ name: "n", meanMs: 1, hz: 1000, stdDevMs: 0, samples: 1 }],
};
writeBenchResult(path, r);
const back = readBenchResult(path);
assert.deepEqual(back, r);

// Tamper with the version, expect rejection on read.
const txt = readFileSync(path, "utf8");
writeFileSync(path, txt.replace(`"schemaVersion": ${BENCH_SCHEMA_VERSION}`, `"schemaVersion": 99`));
assert.throws(() => readBenchResult(path), /schema mismatch/);
});
});

// -------- pgo-patch --------

import {
ATTR_SENTINEL,
PATCH_BEGIN_MARKER,
PATCH_END_MARKER,
PATCH_PLAN_SCHEMA_VERSION,
applyPlanToVendoredCrate,
buildPatchPlan,
ensureLibHeader,
extractFunctionName,
removePatchSection,
renderCargoPatchSection,
revertSourceMarkers,
revertWorkspaceCrate,
rewriteSource,
stripLibHeader,
writePatchSection,
type PatchPlan,
type PatchPlanCrate,
} from "./pgo-patch.ts";

describe("extractFunctionName", () => {
it("strips trait-impl wrappers down to the leaf fn name", () => {
assert.equal(
extractFunctionName(
"<swc_ecma_minifier::compress::pure::Pure as swc_ecma_visit::generated::VisitMut>::visit_mut_expr"
),
"visit_mut_expr"
);
assert.equal(extractFunctionName("<hstr::Atom as core::cmp::PartialEq>::eq"), "eq");
});
it("handles plain crate::path::fn", () => {
assert.equal(
extractFunctionName("swc_ecma_utils::may_have_side_effects"),
"may_have_side_effects"
);
});
it("strips trailing legacy hash and generics", () => {
assert.equal(extractFunctionName("foo::bar::h0123456789abcdef"), "bar");
assert.equal(extractFunctionName("foo::bar<T, U>"), "bar");
assert.equal(extractFunctionName("foo::bar::<T>"), "bar");
});
it("returns null on garbage", () => {
assert.equal(extractFunctionName(""), null);
assert.equal(extractFunctionName("$$$"), null);
});
});

describe("buildPatchPlan", () => {
const profile: PgoProfile = {
schema_version: 1,
git_sha: "x",
created_at: "t",
rustc_version: null,
command: "bench",
total_samples: 1000,
by_crate: [],
top_symbols: [
{ symbol: "<swc_ecma_minifier::pure::Pure as Visit>::visit_mut_expr", crate: "swc_ecma_minifier", samples: 400 },
{ symbol: "swc_ecma_minifier::helper::cleanup", crate: "swc_ecma_minifier", samples: 100 },
{ symbol: "<hstr::Atom as core::cmp::PartialEq>::eq", crate: "hstr", samples: 200 },
{ symbol: "rspack_core::module::build", crate: "rspack_core", samples: 50 },
{ symbol: "_kernel_thing", crate: null, samples: 250 },
],
};
it("groups hot/cold by crate, drops crates with no hot fn", () => {
const plan = buildPatchPlan(profile, { hotCumulativeShare: 0.8 });
assert.equal(plan.schema_version, PATCH_PLAN_SCHEMA_VERSION);
const swc = plan.crates.find(c => c.crate === "swc_ecma_minifier");
assert.ok(swc);
assert.deepEqual(swc.hot.map(f => f.fnName).sort(), ["visit_mut_expr"]);
assert.deepEqual(swc.cold.map(f => f.fnName).sort(), ["cleanup"]);
assert.equal(swc.defaultDecision, "cold");
assert.equal(swc.patchPath, "vendor/swc_ecma_minifier");
});
it("respects custom vendor root", () => {
const plan = buildPatchPlan(profile, { vendorRoot: "third_party" });
for (const c of plan.crates) {
assert.ok(c.patchPath.startsWith("third_party/"));
}
});
});

describe("renderCargoPatchSection / write+remove", () => {
const plan: PatchPlan = {
schema_version: 1,
created_at: "t",
threshold: 0.5,
vendor_root: "vendor",
crates: [
{ crate: "swc_ecma_minifier", patchPath: "vendor/swc_ecma_minifier", defaultDecision: "cold", hot: [{ symbol: "X", fnName: "f", pct: 0.1, decision: "hot" }], cold: [] },
{ crate: "hstr", patchPath: "vendor/hstr", defaultDecision: "cold", hot: [{ symbol: "Y", fnName: "g", pct: 0.05, decision: "hot" }], cold: [] },
],
};
it("renders sentinels + entries + per-crate profile.release.package overrides", () => {
const t = renderCargoPatchSection(plan);
assert.match(t, new RegExp(PATCH_BEGIN_MARKER));
assert.match(t, new RegExp(PATCH_END_MARKER));
assert.match(t, /\[patch\.crates-io\]/);
assert.match(t, /swc_ecma_minifier = \{ path = "vendor\/swc_ecma_minifier" \}/);
// Per-crate `[profile.release.package.X] opt-level = "z"` is what makes
// the patched crates default to size; without it the lib header alone
// has no effect (rustc rejects crate-level `#[optimize]`).
assert.match(t, /\[profile\.release\.package\.swc_ecma_minifier\]\s*\nopt-level = "z"/);
assert.match(t, /\[profile\.release\.package\.hstr\]\s*\nopt-level = "z"/);
});
it("write/remove are byte-identical for round-trip", () => {
const before = `[workspace]\nmembers = ["a"]\n`;
const written = writePatchSection(before, plan);
assert.notEqual(written, before);
const stripped = removePatchSection(written);
assert.equal(stripped.trimEnd(), before.trimEnd());
});
it("write is idempotent", () => {
const before = `[workspace]\nmembers = ["a"]\n`;
const once = writePatchSection(before, plan);
const twice = writePatchSection(once, plan);
assert.equal(once, twice);
});
});

describe("rewriteSource", () => {
it("inserts speed attr on a hot fn and size attr on a cold fn, preserving indentation", () => {
const src = [
"impl Foo {",
"    pub fn visit_mut_expr(&mut self, e: &mut Expr) {}",
"    fn cleanup(&self) {}",
"    fn untouched(&self) {}",
"}",
"",
].join("\n");
const { content, changed } = rewriteSource(
src,
new Set(["visit_mut_expr"]),
new Set(["cleanup"])
);
assert.equal(changed, 2);
assert.match(content, /    #\[optimize\(speed\)\][^\n]*\n    pub fn visit_mut_expr/);
assert.match(content, /    #\[optimize\(size\)\][^\n]*\n    fn cleanup/);
assert.doesNotMatch(content, /optimize[^\n]*\n\s*fn untouched/);
});
it("is idempotent (recognises its own sentinel)", () => {
const src = "fn foo() {}\n";
const hot = new Set(["foo"]);
const once = rewriteSource(src, hot, new Set()).content;
const twice = rewriteSource(once, hot, new Set()).content;
assert.equal(once, twice);
// Sentinel present.
assert.ok(once.includes(ATTR_SENTINEL));
});
it("matches generic fn signatures", () => {
const src = "fn parse<T>(input: T) {}\n";
const { changed } = rewriteSource(src, new Set(["parse"]), new Set());
assert.equal(changed, 1);
});
it("matches pub(crate) and async fn signatures", () => {
const src = "pub(crate) async fn foo() {}\n";
const { changed } = rewriteSource(src, new Set(["foo"]), new Set());
assert.equal(changed, 1);
});
it("does nothing when no symbol matches", () => {
const src = "fn bar() {}\n";
const { content, changed } = rewriteSource(src, new Set(["other"]), new Set());
assert.equal(changed, 0);
assert.equal(content, src);
});
it("preserves CRLF line endings", () => {
const src = "fn foo() {}\r\nfn bar() {}\r\n";
const { content, changed } = rewriteSource(src, new Set(["foo"]), new Set());
assert.equal(changed, 1);
assert.match(content, /\r\n/);
});
});

describe("ensureLibHeader / stripLibHeader", () => {
it("inserts header on a clean file and is idempotent", () => {
const src = "//! crate\n";
const once = ensureLibHeader(src, "cold");
const twice = ensureLibHeader(once, "cold");
assert.equal(once, twice);
assert.match(once, /#!\[feature\(optimize_attribute\)\]/);
// `#[optimize]` is fn-only on nightly; the lib header must NOT contain
// a crate-level `optimize(size|speed)` (rustc rejects it).
assert.doesNotMatch(once, /#!\[cfg_attr\([^)]*optimize\(/);
});
it("ignores defaultDecision (lib header is the same shape regardless)", () => {
const cold = ensureLibHeader("//! crate\n", "cold");
const hot = ensureLibHeader("//! crate\n", "hot");
assert.equal(cold, hot);
});
it("strip removes only the managed header", () => {
const src = ensureLibHeader("//! crate\n", "cold");
const back = stripLibHeader(src);
assert.equal(back, "//! crate\n");
});
});

describe("applyPlanToVendoredCrate", () => {
it("walks .rs files via injected io and applies edits", () => {
const files: Record<string, string> = {
"/v/swc/src/lib.rs": "//! crate\nfn driver() {}\n",
"/v/swc/src/visit.rs": "pub fn visit_mut_expr() {}\nfn helper() {}\n",
"/v/swc/src/skip.rs": "fn untouched() {}\n",
};
const writes: Record<string, string> = {};
const planCrate: PatchPlanCrate = {
crate: "swc",
patchPath: "vendor/swc",
defaultDecision: "cold",
hot: [{ symbol: "x::visit_mut_expr", fnName: "visit_mut_expr", pct: 0.1, decision: "hot" }],
cold: [{ symbol: "x::helper", fnName: "helper", pct: 0.01, decision: "cold" }],
};
const result = applyPlanToVendoredCrate("/v/swc", planCrate, {
readFile: p => files[p],
writeFile: (p, c) => { writes[p] = c; },
listFiles: () => Object.keys(files),
});
assert.ok(result.totalChanges > 0);
// lib.rs gets the header.
assert.match(writes["/v/swc/src/lib.rs"], /#!\[feature\(optimize_attribute\)\]/);
// visit.rs gets both annotations.
assert.match(writes["/v/swc/src/visit.rs"], /#\[optimize\(speed\)\][^\n]*\n\s*pub fn visit_mut_expr/);
assert.match(writes["/v/swc/src/visit.rs"], /#\[optimize\(size\)\][^\n]*\n\s*fn helper/);
// skip.rs has no matching name; content should be unchanged AND not written.
assert.equal(writes["/v/swc/src/skip.rs"], undefined);
});
it("does not rewrite an already-patched lib.rs (idempotent, no spurious writes)", () => {
const seeded = ensureLibHeader("//! crate\n", "cold");
const files: Record<string, string> = { "/v/swc/src/lib.rs": seeded };
const writes: Record<string, string> = {};
const planCrate: PatchPlanCrate = {
crate: "swc",
patchPath: "vendor/swc",
defaultDecision: "cold",
hot: [],
cold: [],
};
const result = applyPlanToVendoredCrate("/v/swc", planCrate, {
readFile: p => files[p],
writeFile: (p, c) => { writes[p] = c; },
listFiles: () => Object.keys(files),
});
assert.equal(result.totalChanges, 0);
assert.equal(writes["/v/swc/src/lib.rs"], undefined);
});
});

describe("buildPatchPlan workspace-crate detection", () => {
it("classifies crates as workspace when isWorkspaceMember returns true", () => {
const profile = {
schema_version: 1,
git_sha: "x", created_at: "t", rustc_version: null, command: "c",
total_samples: 100,
by_crate: [
{ crate: "rspack_core", samples: 60, pct: 0.6 },
{ crate: "swc_ecma_minifier", samples: 40, pct: 0.4 },
],
top_symbols: [
{ symbol: "rspack_core::module::build", crate: "rspack_core", samples: 60 },
{ symbol: "swc_ecma_minifier::compress::run", crate: "swc_ecma_minifier", samples: 40 },
],
} as const;
const plan = buildPatchPlan(profile as any, {
hotCumulativeShare: 0.99,
isWorkspaceMember: (c) => c === "rspack_core",
});
const rs = plan.crates.find(c => c.crate === "rspack_core")!;
const swc = plan.crates.find(c => c.crate === "swc_ecma_minifier")!;
assert.equal(rs.kind, "workspace");
assert.equal(rs.patchPath, "crates/rspack_core");
assert.equal(swc.kind, "third-party");
assert.equal(swc.patchPath, "vendor/swc_ecma_minifier");
});
});

describe("renderCargoPatchSection with workspace crates", () => {
it("emits [patch.crates-io] only for third-party; lists workspace crates as comments", () => {
const plan: PatchPlan = {
schema_version: 1, created_at: "t", threshold: 0.5, vendor_root: "vendor",
crates: [
{ crate: "swc_ecma_minifier", patchPath: "vendor/swc_ecma_minifier", kind: "third-party", defaultDecision: "cold", hot: [{ symbol: "X", fnName: "f", pct: 0.1, decision: "hot" }], cold: [] },
{ crate: "rspack_core", patchPath: "crates/rspack_core", kind: "workspace", defaultDecision: "cold", hot: [{ symbol: "Y", fnName: "g", pct: 0.05, decision: "hot" }], cold: [] },
],
};
const t = renderCargoPatchSection(plan);
assert.match(t, /\[patch\.crates-io\]/);
assert.match(t, /swc_ecma_minifier = \{ path = "vendor\/swc_ecma_minifier" \}/);
// Workspace crate must NOT appear as a [patch.crates-io] entry.
assert.doesNotMatch(t, /^rspack_core = \{ path/m);
// Nor as a [profile.release.package.X] override (the workspace-default
// `opt-level = "z"` covers it).
assert.doesNotMatch(t, /\[profile\.release\.package\.rspack_core\]/);
// But it should appear as a traceability comment.
assert.match(t, /Workspace crate.*in-place/);
assert.match(t, /rspack_core .*crates\/rspack_core/);
});
it("omits the [patch.crates-io] header when only workspace crates are in the plan", () => {
const plan: PatchPlan = {
schema_version: 1, created_at: "t", threshold: 0.5, vendor_root: "vendor",
crates: [
{ crate: "rspack_core", patchPath: "crates/rspack_core", kind: "workspace", defaultDecision: "cold", hot: [{ symbol: "X", fnName: "f", pct: 0.1, decision: "hot" }], cold: [] },
],
};
const t = renderCargoPatchSection(plan);
assert.doesNotMatch(t, /\[patch\.crates-io\]/);
assert.doesNotMatch(t, /\[profile\.release\.package\./);
assert.match(t, /rspack_core .*crates\/rspack_core/);
});
});

describe("revertSourceMarkers", () => {
it("strips per-fn markers but leaves user attributes intact", () => {
const src = [
"impl Foo {",
"    #[optimize(speed)] // pgo-managed",
"    pub fn hot(&self) {}",
"    #[optimize(size)] // pgo-managed",
"    fn cold(&self) {}",
"    #[inline(always)]",
"    fn user_attr(&self) {}",
"}",
"",
].join("\n");
const { content, changed } = revertSourceMarkers(src);
assert.equal(changed, 2);
assert.doesNotMatch(content, /pgo-managed/);
assert.match(content, /#\[inline\(always\)\]\n\s*fn user_attr/);
assert.match(content, /pub fn hot/);
assert.match(content, /fn cold/);
});
it("is a no-op on clean source", () => {
const src = "fn f() {}\nfn g() {}\n";
const { content, changed } = revertSourceMarkers(src);
assert.equal(changed, 0);
assert.equal(content, src);
});
it("round-trips with rewriteSource for byte-identical revert", () => {
const original = [
"impl Foo {",
"    pub fn hot(&self) {}",
"    fn cold(&self) {}",
"}",
"",
].join("\n");
const after = rewriteSource(original, new Set(["hot"]), new Set(["cold"]));
// Sanity: rewriteSource actually injected markers we'll later strip.
assert.equal(after.changed, 2);
assert.match(after.content, /#\[optimize\(speed\)\][^\n]*pgo-managed/);
assert.match(after.content, /#\[optimize\(size\)\][^\n]*pgo-managed/);
const reverted = revertSourceMarkers(after.content);
assert.equal(reverted.content, original);
});
});

describe("revertWorkspaceCrate", () => {
it("strips lib header + per-fn markers; idempotent on clean source", () => {
const files: Record<string, string> = {
"/c/src/lib.rs": [
"// pgo-managed: profile-guided optimisation markers begin",
"#![feature(optimize_attribute)]",
"// pgo-managed: profile-guided optimisation markers end",
"",
"pub mod m;",
"",
].join("\n"),
"/c/src/m.rs": [
"#[optimize(speed)] // pgo-managed",
"pub fn hot() {}",
"fn untouched() {}",
"",
].join("\n"),
};
const writes: Record<string, string> = {};
const result = revertWorkspaceCrate("/c", {
readFile: (p) => files[p],
writeFile: (p, c) => { writes[p] = c; },
listFiles: () => Object.keys(files),
});
assert.equal(result.totalChanges, 2); // 1 header + 1 per-fn
assert.doesNotMatch(writes["/c/src/lib.rs"], /pgo-managed/);
assert.match(writes["/c/src/lib.rs"], /pub mod m;/);
assert.doesNotMatch(writes["/c/src/m.rs"], /pgo-managed/);
assert.match(writes["/c/src/m.rs"], /pub fn hot/);
// Re-running on the cleaned content is a no-op.
const clean = { ...writes };
const writes2: Record<string, string> = {};
const r2 = revertWorkspaceCrate("/c", {
readFile: (p) => clean[p],
writeFile: (p, c) => { writes2[p] = c; },
listFiles: () => Object.keys(clean),
});
assert.equal(r2.totalChanges, 0);
});
});
