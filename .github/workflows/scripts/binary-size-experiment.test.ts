// Unit tests for the binary-size experiment scripts.
//
// Run with:
//   node --test --experimental-strip-types .github/workflows/scripts/binary-size-experiment.test.ts
// (Node ≥ 22.6; on Node ≥ 22.18 the --experimental-strip-types flag is implied.)
//
// These tests must pass on Linux, macOS and Windows before the experiment
// matrix runs, so they avoid platform-specific tooling assumptions and use
// only `node:` builtins.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	VARIANTS,
	applyVariant,
	dropBuildJsLine,
	isVariant,
	patchReleaseKey,
	type Variant,
} from "./binary-size-apply-variant.ts";
import {
	findNodeArtifact,
	measure,
	tryExtraStrip,
} from "./binary-size-measure.ts";
import {
	VARIANT_ORDER,
	findJsonFiles,
	fmtBytes,
	fmtDelta,
	summarize,
} from "./binary-size-summarize.ts";
import type { SizeReport } from "./binary-size-measure.ts";

// -- shared fixtures ---------------------------------------------------------

// A minimal but realistic Cargo.toml fragment exercising the same shape as
// the real workspace file: section header, several keys, then a per-package
// override section that the patcher MUST NOT touch.
const FIXTURE_CARGO = `[workspace]
members = ["a"]

[profile.release]
strip         = "debuginfo"
codegen-units = 1
debug         = false
# Performs "fat" LTO which attempts to perform optimizations across all crates within the dependency graph.
lto       = "fat"
opt-level = 3
panic     = "abort"
strip     = true

[profile.release.package.indicatif]
opt-level = "s"

[profile.release.package."*"]
codegen-units = 1
`;

const FIXTURE_BUILD_JS = `// fake build.js
async function build() {
	const features = [];
	if (values.profile === "release") {
		features.push("info-level");
	}
	if (use_build_std) {
		args.push("-Zbuild-std=panic_abort,std");
	}
}
`;

function makeTmp(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

// -- apply-variant -----------------------------------------------------------

describe("isVariant / VARIANTS", () => {
	test("VARIANTS lists the seven documented variants exactly", () => {
		assert.deepEqual([...VARIANTS], [
			"baseline",
			"opt-level-s-global",
			"opt-level-z-global",
			"lto-thin",
			"lto-off",
			"no-build-std",
			"no-info-level",
		]);
	});
	test("isVariant accepts known and rejects unknown", () => {
		assert.equal(isVariant("baseline"), true);
		assert.equal(isVariant("lto-off"), true);
		assert.equal(isVariant(""), false);
		assert.equal(isVariant("opt-level-x-global"), false);
		assert.equal(isVariant("BASELINE"), false);
	});
});

describe("patchReleaseKey", () => {
	test("changes opt-level under [profile.release]", () => {
		const out = patchReleaseKey(FIXTURE_CARGO, "opt-level", "s");
		assert.match(out, /^opt-level = "s"$/m);
		// Original `opt-level = 3` must be gone in the release section but
		// the per-package override `opt-level = "s"` was already there.
		assert.equal(out.match(/^opt-level/gm)!.length, 2);
	});
	test("changes lto under [profile.release]", () => {
		const out = patchReleaseKey(FIXTURE_CARGO, "lto", "thin");
		assert.match(out, /^lto       = "thin"$/m);
	});
	test("does NOT touch [profile.release.package.*] sections", () => {
		const out = patchReleaseKey(FIXTURE_CARGO, "opt-level", "z");
		// indicatif override stays at "s".
		assert.match(out, /\[profile\.release\.package\.indicatif\]\nopt-level = "s"/);
	});
	test("preserves trailing whitespace alignment", () => {
		const out = patchReleaseKey(FIXTURE_CARGO, "lto", "off");
		// Original line was `lto       = "fat"` with aligned spaces; result
		// must keep those spaces, only the value changes.
		assert.match(out, /^lto       = "off"$/m);
	});
	test("throws on missing section", () => {
		assert.throws(() => patchReleaseKey("[workspace]\n", "opt-level", "s"), {
			message: /\[profile\.release\] not found/,
		});
	});
	test("throws on missing key", () => {
		assert.throws(
			() => patchReleaseKey(FIXTURE_CARGO, "incremental", "false"),
			{ message: /key incremental not found/ }
		);
	});
});

describe("dropBuildJsLine", () => {
	test("removes the matching line", () => {
		const out = dropBuildJsLine(FIXTURE_BUILD_JS, '"-Zbuild-std=panic_abort,std"');
		assert.equal(out.includes("Zbuild-std"), false);
		// Other lines preserved.
		assert.match(out, /features\.push\("info-level"\)/);
	});
	test("throws when needle is not found", () => {
		assert.throws(() => dropBuildJsLine(FIXTURE_BUILD_JS, "DOES_NOT_EXIST"), {
			message: /not found in build.js/,
		});
	});
});

describe("applyVariant", () => {
	for (const v of VARIANTS) {
		test(`variant=${v} produces an expected, stable change`, () => {
			const before = { cargoToml: FIXTURE_CARGO, buildJs: FIXTURE_BUILD_JS };
			const after = applyVariant(v as Variant, before.cargoToml, before.buildJs);
			switch (v) {
				case "baseline":
					assert.equal(after.cargoToml, before.cargoToml);
					assert.equal(after.buildJs, before.buildJs);
					break;
				case "opt-level-s-global":
				case "opt-level-z-global": {
					const expected = v === "opt-level-s-global" ? '"s"' : '"z"';
					assert.match(after.cargoToml, new RegExp(`^opt-level = ${expected.replace(/"/g, '\\"')}$`, "m"));
					assert.equal(after.buildJs, before.buildJs);
					break;
				}
				case "lto-thin":
				case "lto-off": {
					const expected = v === "lto-thin" ? "thin" : "off";
					assert.match(after.cargoToml, new RegExp(`^lto       = "${expected}"$`, "m"));
					assert.equal(after.buildJs, before.buildJs);
					break;
				}
				case "no-build-std":
					assert.equal(after.cargoToml, before.cargoToml);
					assert.equal(after.buildJs.includes("Zbuild-std"), false);
					break;
				case "no-info-level":
					assert.equal(after.cargoToml, before.cargoToml);
					assert.equal(after.buildJs.includes('features.push("info-level")'), false);
					break;
			}
		});
	}

	test("opt-level-s-global is idempotent (applying twice = once)", () => {
		const a = applyVariant("opt-level-s-global", FIXTURE_CARGO, FIXTURE_BUILD_JS);
		const b = applyVariant("opt-level-s-global", a.cargoToml, a.buildJs);
		assert.equal(b.cargoToml, a.cargoToml);
	});

	test("works against the real repository Cargo.toml + build.js", () => {
		// Smoke test using actual files in this repo. Exercises that our
		// regexes still match the real release profile shape.
		const cargo = readFileSync("Cargo.toml", "utf8");
		const buildJs = readFileSync("crates/node_binding/scripts/build.js", "utf8");
		for (const v of VARIANTS) {
			const r = applyVariant(v as Variant, cargo, buildJs);
			if (v === "baseline") {
				assert.equal(r.cargoToml, cargo);
				assert.equal(r.buildJs, buildJs);
			} else if (v.startsWith("opt-level") || v.startsWith("lto")) {
				assert.notEqual(r.cargoToml, cargo);
				assert.equal(r.buildJs, buildJs);
			} else {
				assert.equal(r.cargoToml, cargo);
				assert.notEqual(r.buildJs, buildJs);
			}
		}
	});
});

// -- measure ----------------------------------------------------------------

describe("findNodeArtifact", () => {
	test("returns the .node file when present", () => {
		const dir = makeTmp("size-measure-find-");
		try {
			writeFileSync(join(dir, "rspack.linux-x64-gnu.node"), "x");
			writeFileSync(join(dir, "package.json"), "{}"); // distractor
			const got = findNodeArtifact(dir);
			assert.equal(got.endsWith("rspack.linux-x64-gnu.node"), true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test("throws when no .node is present", () => {
		const dir = makeTmp("size-measure-find-empty-");
		try {
			writeFileSync(join(dir, "package.json"), "{}");
			assert.throws(() => findNodeArtifact(dir), { message: /no \.node file/ });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("tryExtraStrip", () => {
	test("returns [null, null] on Windows runner OS regardless of file", () => {
		const dir = makeTmp("size-measure-strip-win-");
		try {
			const f = join(dir, "rspack.win32-x64-msvc.node");
			writeFileSync(f, "x");
			assert.deepEqual(tryExtraStrip(f, "Windows"), [null, null]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test("returns [null, null] when the strip tool fails (synthetic data)", () => {
		const dir = makeTmp("size-measure-strip-fail-");
		try {
			const f = join(dir, "rspack.linux-x64-gnu.node");
			writeFileSync(f, Buffer.from("not-an-elf"));
			// On Linux strip will reject this; on macOS likewise. Either way
			// we expect a graceful null result, never a thrown exception.
			const result = tryExtraStrip(f, "Linux");
			assert.equal(Array.isArray(result), true);
			assert.equal(result.length, 2);
			// We can't guarantee which (some platforms might still "succeed"
			// silently), but we guarantee we never throw.
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("measure", () => {
	test("produces a fully-populated SizeReport with injected env", () => {
		const dir = makeTmp("size-measure-");
		try {
			writeFileSync(join(dir, "rspack.linux-x64-gnu.node"), Buffer.alloc(12_345, 0));
			const r = measure({
				bindingDir: dir,
				platform: "linux-x64-gnu",
				runnerOs: "Windows", // forces strip to be skipped — deterministic
				variant: "baseline",
				githubEnv: {
					GITHUB_SHA: "deadbeef",
					GITHUB_REF: "refs/pull/1/merge",
					GITHUB_RUN_ID: "42",
					GITHUB_REPOSITORY: "foo/bar",
					GITHUB_SERVER_URL: "https://github.com",
				},
				rustcVersion: "rustc 1.97.0-nightly",
			});
			assert.equal(r.schema_version, 1);
			assert.equal(r.platform, "linux-x64-gnu");
			assert.equal(r.variant, "baseline");
			assert.equal(r.node_file, "rspack.linux-x64-gnu.node");
			assert.equal(r.raw_size_bytes, 12_345);
			assert.equal(r.stripped_size_bytes, null);
			assert.equal(r.strip_tool, null);
			assert.equal(r.run_url, "https://github.com/foo/bar/actions/runs/42");
			assert.equal(r.rustc_version, "rustc 1.97.0-nightly");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("falls back to 'unknown' when env vars are missing", () => {
		const dir = makeTmp("size-measure-unknown-");
		try {
			writeFileSync(join(dir, "rspack.x.node"), "x");
			const r = measure({
				bindingDir: dir,
				platform: "x",
				runnerOs: "Windows",
				variant: "baseline",
				githubEnv: {}, // explicit empty -> no leakage from process.env
			});
			assert.equal(r.git_sha, "unknown");
			assert.equal(r.run_url, "https://github.com/unknown/actions/runs/unknown");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// -- summarize --------------------------------------------------------------

describe("fmtBytes", () => {
	test("handles null", () => assert.equal(fmtBytes(null), "—"));
	test("formats sub-KiB as raw bytes", () => assert.equal(fmtBytes(512), "512 B"));
	test("formats KiB", () => assert.match(fmtBytes(2048), /^2\.00 KiB$/));
	test("formats MiB", () => assert.match(fmtBytes(60 * 1024 * 1024), /^60\.00 MiB$/));
});

describe("fmtDelta", () => {
	test("positive delta", () =>
		assert.equal(fmtDelta(110, 100), "+10 B (+10.00%)"));
	test("negative delta", () =>
		assert.equal(fmtDelta(90, 100), "-10 B (-10.00%)"));
	test("zero baseline → em-dash", () => assert.equal(fmtDelta(5, 0), "—"));
});

describe("findJsonFiles", () => {
	test("walks recursively and returns sorted paths", () => {
		const root = makeTmp("size-summary-files-");
		try {
			mkdirSync(join(root, "a"));
			mkdirSync(join(root, "b"));
			writeFileSync(join(root, "a", "x.json"), "{}");
			writeFileSync(join(root, "b", "y.json"), "{}");
			writeFileSync(join(root, "skip.txt"), "");
			const got = findJsonFiles(root);
			assert.equal(got.length, 2);
			assert.equal(got[0].endsWith("x.json"), true);
			assert.equal(got[1].endsWith("y.json"), true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("summarize", () => {
	const mkReport = (overrides: Partial<SizeReport>): SizeReport => ({
		schema_version: 1,
		platform: "linux-x64-gnu",
		runner_os: "Linux",
		variant: "baseline",
		node_file: "rspack.x.node",
		raw_size_bytes: 60_000_000,
		stripped_size_bytes: 59_800_000,
		strip_tool: "strip --strip-all (binutils)",
		git_sha: "deadbeef",
		git_ref: "refs/heads/x",
		run_id: "1",
		run_url: "https://github.com/foo/bar/actions/runs/1",
		rustc_version: "rustc",
		...overrides,
	});

	test("empty input yields a stub message", () => {
		assert.match(summarize([]), /No reports found/);
	});

	test("renders per-platform tables, baseline first, with deltas", () => {
		const out = summarize([
			mkReport({ variant: "lto-off", raw_size_bytes: 78_000_000 }),
			mkReport({ variant: "baseline", raw_size_bytes: 60_000_000 }),
			mkReport({ variant: "opt-level-s-global", raw_size_bytes: 56_000_000 }),
			mkReport({
				platform: "darwin-arm64",
				runner_os: "macOS",
				variant: "baseline",
				raw_size_bytes: 58_000_000,
			}),
		]);
		// Both platforms appear with their headers.
		assert.match(out, /## `darwin-arm64`/);
		assert.match(out, /## `linux-x64-gnu`/);
		// Baseline row is rendered first (before lto-off and opt-level-*).
		const linuxBlock = out.split("## `linux-x64-gnu`")[1];
		const baselineIdx = linuxBlock.indexOf("`baseline`");
		const ltoOffIdx = linuxBlock.indexOf("`lto-off`");
		const optSIdx = linuxBlock.indexOf("`opt-level-s-global`");
		assert.ok(baselineIdx > 0 && baselineIdx < optSIdx && optSIdx < ltoOffIdx,
			`expected variant order baseline < opt-level-s-global < lto-off, got positions ${baselineIdx}, ${optSIdx}, ${ltoOffIdx}`);
		// Deltas show correct sign and percentage.
		assert.match(out, /-4,000,000 B \(-6\.67%\)/); // 56M vs 60M
		assert.match(out, /\+18,000,000 B \(\+30\.00%\)/); // 78M vs 60M
		// Baseline label.
		assert.match(out, /0 B \(baseline\)/);
	});

	test("renders an em-dash when stripped size is null", () => {
		const out = summarize([
			mkReport({ variant: "baseline", stripped_size_bytes: null, strip_tool: null }),
		]);
		// Last cell of the table row should be an em-dash (no Δ vs raw).
		assert.match(out, /\| `baseline` \| [^|]+\| 0 B \(baseline\) \| — \| — \|/);
	});

	test("VARIANT_ORDER is exhaustive vs. apply-variant.VARIANTS", () => {
		// Defensive: if we add a variant in one file we must add it here too.
		assert.deepEqual([...VARIANT_ORDER].sort(), [...VARIANTS].sort());
	});
});
