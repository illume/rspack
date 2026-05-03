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
	readWorkspaceReleaseOptLevel,
	removeManagedBlock,
	renderManagedBlock,
	writeManagedBlock,
} from "./pgo-apply-overrides.ts";
import { classify } from "./pgo-classify.ts";
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
		// rspack_core (0.60) + swc_parser (0.80) — both come from "before the
		// threshold is crossed" (i.e. cumulative was < 0.85 when each was
		// considered). regex pushes us to 0.90 and is the first cold crate.
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
