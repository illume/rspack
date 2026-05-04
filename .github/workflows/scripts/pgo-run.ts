// Driver: profile → store → read → optimize → rebuild → validate.
//
// Usage:
//   node --experimental-strip-types pgo-run.ts profile  -- <bench-cmd> [args...]
//   node --experimental-strip-types pgo-run.ts apply    [--profile <path>]
//   node --experimental-strip-types pgo-run.ts revert
//   node --experimental-strip-types pgo-run.ts all      -- <bench-cmd> [args...]
//
// `all` performs the full sequence:
//   1. profile  — perf record + perf script + write perf_profiles/<sha>.json
//   2. apply    — read profile, classify, write managed Cargo.toml block
//   3. rebuild  — run the project's existing release build script
//   4. validate — confirm the produced .node artifact exists and is non-empty
//
// Validation is intentionally minimal — the heavy benchmarking is the
// caller's job. We only check the artifact exists; the user can re-run
// their own benchmark afterwards to confirm perf.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argv, env, exit } from "node:process";

import {
	applyOverridesToFile,
	removeManagedBlock,
	setWorkspaceReleaseOptLevel,
	unsetWorkspaceReleaseOptLevel,
} from "./pgo-apply-overrides.ts";
import { classify } from "./pgo-classify.ts";
import {
	profilePath,
	readProfile,
	runProfile,
} from "./pgo-profile.ts";
import { buildReport, renderMarkdown } from "./pgo-report.ts";
import {
	classifyFunctions,
	renderFunctionClassification,
} from "./pgo-classify-functions.ts";
import {
	benchResultPath,
	compareBenches,
	readBenchResult,
	renderBenchDiffMarkdown,
	runBenchAndCollect,
	writeBenchResult,
} from "./pgo-bench.ts";
import {
	applyPlanToVendoredCrate,
	buildPatchPlan,
	removePatchSection,
	renderCargoPatchSection,
	renderPlanMarkdown,
	revertWorkspaceCrate,
	writePatchSection,
} from "./pgo-patch.ts";

function repoRoot(): string {
	return env.REPO_ROOT ?? process.cwd();
}

function cargoTomlPath(): string {
	return join(repoRoot(), "Cargo.toml");
}

function gitSha(): string {
	return execFileSync("git", ["-C", repoRoot(), "rev-parse", "HEAD"], {
		encoding: "utf8",
	}).trim();
}

function step(name: string): void {
	console.log(`\n[pgo-run] ▶ ${name}`);
}

function cmdProfile(rest: string[]): string {
	step(`profile (perf record): ${rest.join(" ")}`);
	const { path, profile } = runProfile({
		repoRoot: repoRoot(),
		command: rest,
	});
	console.log(
		`  wrote ${path}: ${profile.total_samples} samples, ${profile.by_crate.length} crates`
	);
	return path;
}

export interface ApplyOpts {
	threshold?: number;
	hotOptLevel?: string;
	coldOptLevel?: string;
	workspaceDefault?: string;
	alwaysHot?: string[];
	alwaysCold?: string[];
	/**
	 * When true, skip writing the managed `[profile.release.package.X]`
	 * block. Use together with `--workspace-default z` to get "shrink
	 * everything via workspace, then surgically lift hot fns back to speed
	 * via `pgo-run.ts patch --apply`" — i.e. the workspace knob handles
	 * the long tail and the per-fn `#[optimize(speed)]` markers handle the
	 * hot path. Without this, `apply` would also pin hot CRATES back to
	 * `=3`, which is a coarser mechanism than per-fn markers and is
	 * redundant when `patch` is going to override the same crates anyway.
	 */
	noPackageOverrides?: boolean;
}

function cmdApply(profileFile: string, opts: ApplyOpts = {}): { hot: number; cold: number } {
	step(`apply overrides from ${profileFile}`);
	const profile = readProfile(profileFile);
	const classification = classify(profile, {
		hotCumulativeShare: opts.threshold,
		alwaysHot: opts.alwaysHot,
		alwaysCold: opts.alwaysCold,
	});
	if (opts.workspaceDefault !== undefined) {
		const before = readFileSync(cargoTomlPath(), "utf8");
		const after = setWorkspaceReleaseOptLevel(before, opts.workspaceDefault);
		if (after !== before) {
			writeFileSync(cargoTomlPath(), after);
			console.log(
				`  workspace [profile.release].opt-level → ${opts.workspaceDefault} (original preserved in sentinel comment)`
			);
		}
	}
	if (opts.noPackageOverrides) {
		console.log(
			`  --no-package-overrides: skipping managed [profile.release.package.X] block (${classification.hot.length} hot / ${classification.cold.length} cold not pinned)`
		);
		return { hot: classification.hot.length, cold: classification.cold.length };
	}
	const { changed } = applyOverridesToFile(cargoTomlPath(), classification, {
		hotOptLevel: opts.hotOptLevel,
		coldOptLevel: opts.coldOptLevel,
	});
	console.log(
		`  ${changed ? "updated" : "unchanged"}: ${classification.hot.length} hot crates @ opt-level=${opts.hotOptLevel ?? "3"}, ${classification.cold.length} cold crates @ opt-level=${opts.coldOptLevel ?? '"z"'} (threshold=${opts.threshold ?? 0.85})`
	);
	for (const c of classification.hot.slice(0, 10)) {
		console.log(`    hot  ${c.crate.padEnd(40)} ${(c.pct * 100).toFixed(2)}%`);
	}
	if (classification.hot.length > 10) {
		console.log(`    … +${classification.hot.length - 10} more hot`);
	}
	return { hot: classification.hot.length, cold: classification.cold.length };
}

function cmdRevert(): void {
	step("revert overrides");
	const before = readFileSync(cargoTomlPath(), "utf8");
	let after = removeManagedBlock(before);
	after = unsetWorkspaceReleaseOptLevel(after);
	after = removePatchSection(after);
	if (after !== before) {
		writeFileSync(cargoTomlPath(), after);
		console.log("  removed managed pgo block + restored workspace opt-level + removed [patch.crates-io] block");
	} else {
		console.log("  no managed pgo state present");
	}
}

function cmdRebuild(): void {
	step("rebuild release");
	const r = spawnSync("pnpm", ["run", "build:binding:release"], {
		cwd: repoRoot(),
		stdio: "inherit",
		env,
	});
	if (r.status !== 0) {
		throw new Error(`rebuild exited ${r.status}`);
	}
}

function cmdValidate(): void {
	step("validate artifact");
	// Find any rspack.<platform>.node under crates/node_binding/ or npm/.
	// We don't hard-code the platform; just walk the obvious targets.
	const candidates = [
		join(repoRoot(), "crates/node_binding"),
		join(repoRoot(), "npm"),
	];
	const found: string[] = [];
	const walk = (dir: string, depth = 0) => {
		if (!existsSync(dir) || depth > 4) return;
		for (const ent of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, ent.name);
			if (ent.isDirectory()) walk(p, depth + 1);
			else if (ent.isFile() && ent.name.endsWith(".node")) found.push(p);
		}
	};
	for (const c of candidates) walk(c);
	if (found.length === 0) {
		throw new Error("no .node artifact found after rebuild");
	}
	for (const p of found) {
		const sz = statSync(p).size;
		if (sz <= 0) throw new Error(`artifact ${p} is empty`);
		console.log(`  ${p}: ${sz} bytes (${(sz / 1024 / 1024).toFixed(2)} MiB)`);
	}
}

export function parseApplyOpts(rest: string[]): { profile: string | undefined; opts: ApplyOpts } {
	const opts: ApplyOpts = {};
	let profile: string | undefined;
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a === "--profile") profile = rest[++i];
		else if (a === "--threshold") opts.threshold = Number(rest[++i]);
		else if (a === "--hot-opt-level") opts.hotOptLevel = rest[++i];
		else if (a === "--cold-opt-level") opts.coldOptLevel = rest[++i];
		else if (a === "--workspace-default") opts.workspaceDefault = rest[++i];
		else if (a === "--always-hot") {
			opts.alwaysHot = (opts.alwaysHot ?? []).concat(
				rest[++i].split(",").map(s => s.trim()).filter(Boolean)
			);
		}
		else if (a === "--always-cold") {
			opts.alwaysCold = (opts.alwaysCold ?? []).concat(
				rest[++i].split(",").map(s => s.trim()).filter(Boolean)
			);
		}
		else if (a === "--no-package-overrides") {
			// Skip the managed `[profile.release.package.X]` block so the
			// only effect of `apply` is the workspace-level opt-level knob.
			// Pairs with `pgo-run.ts patch --apply` to deliver per-fn speed
			// markers instead of crate-level pin-back.
			opts.noPackageOverrides = true;
		}
		else if (a === "--aggressive-size") {
			// Convenience: workspace=z, hot=3, cold=z (cold becomes a no-op).
			// Captures the user-requested "z everywhere except the hot path"
			// configuration in a single flag.
			opts.workspaceDefault = "z";
			opts.hotOptLevel = opts.hotOptLevel ?? "3";
			opts.coldOptLevel = opts.coldOptLevel ?? '"z"';
		}
	}
	return { profile, opts };
}

function cmdReport(profileFile: string, opts: { threshold?: number; functionsPerCrate?: number; topGlobal?: number } = {}): void {
	step(`report (function-level) from ${profileFile}`);
	const profile = readProfile(profileFile);
	const report = buildReport(profile, {
		hotCumulativeShare: opts.threshold,
		functionsPerCrate: opts.functionsPerCrate,
		topGlobalFunctions: opts.topGlobal,
	});
	process.stdout.write(renderMarkdown(report, {
		functionsPerCrate: opts.functionsPerCrate,
		topGlobalFunctions: opts.topGlobal,
	}));
}

function cmdClassifyFunctions(
	profileFile: string,
	opts: { threshold?: number; restrict?: string[] } = {}
): void {
	step(`classify-fns (function-level) from ${profileFile}`);
	const profile = readProfile(profileFile);
	const result = classifyFunctions(profile, {
		hotCumulativeShare: opts.threshold,
		restrictToCrates: opts.restrict,
	});
	process.stdout.write(renderFunctionClassification(result));
}

function cmdBench(label: string): string {
	step(`bench (runtime) label=${label}`);
	const sha = gitSha();
	const out = benchResultPath(repoRoot(), sha, label);
	const result = runBenchAndCollect({
		repoRoot: repoRoot(),
		gitSha: sha,
		label,
	});
	writeBenchResult(out, result);
	console.log(`  wrote ${out} (${result.samples.length} samples)`);
	for (const s of result.samples) {
		console.log(
			`    ${s.name}: mean=${s.meanMs.toFixed(3)} ms hz=${s.hz.toFixed(2)} sd=${s.stdDevMs.toFixed(3)} ms n=${s.samples}`
		);
	}
	return out;
}

function cmdBenchCompare(baselineFile: string, candidateFile: string): void {
	step(`bench-compare ${baselineFile} vs ${candidateFile}`);
	const a = readBenchResult(baselineFile);
	const b = readBenchResult(candidateFile);
	const diff = compareBenches(a, b);
	process.stdout.write(renderBenchDiffMarkdown(diff));
}

interface PatchOpts {
	threshold?: number;
	vendorRoot?: string;
	apply?: boolean;
	planOut?: string;
}

function cmdPatch(profileFile: string, opts: PatchOpts): void {
	step(`patch (cargo-patch + source rewrite) from ${profileFile}`);
	const profile = readProfile(profileFile);
	const plan = buildPatchPlan(profile, {
		hotCumulativeShare: opts.threshold,
		vendorRoot: opts.vendorRoot,
		repoRoot: repoRoot(),
	});
	const tp = plan.crates.filter(c => c.kind === "third-party").length;
	const ws = plan.crates.filter(c => c.kind === "workspace").length;
	console.log(
		`  plan: ${plan.crates.length} crate(s) (${tp} third-party + ${ws} workspace), ${plan.crates.reduce((n, c) => n + c.hot.length, 0)} hot fn(s), ${plan.crates.reduce((n, c) => n + c.cold.length, 0)} cold fn(s)`
	);
	if (opts.planOut) {
		writeFileSync(opts.planOut, JSON.stringify(plan, null, 2) + "\n");
		console.log(`  wrote plan: ${opts.planOut}`);
	}
	// Always print a Markdown summary so a CI run leaves a readable record.
	process.stdout.write(renderPlanMarkdown(plan));
	// Update Cargo.toml [patch.crates-io] block.
	const before = readFileSync(cargoTomlPath(), "utf8");
	const after = writePatchSection(before, plan);
	if (after !== before) {
		writeFileSync(cargoTomlPath(), after);
		console.log("  updated Cargo.toml [patch.crates-io] managed block");
	} else {
		console.log("  Cargo.toml [patch.crates-io] managed block unchanged");
	}
	if (opts.apply) {
		// Rewrite vendored sources (third-party) and workspace sources
		// (in-place) — the dispatch is by `c.kind`.
		const vendor = opts.vendorRoot ?? plan.vendor_root;
		const vendorAbs = vendor.startsWith("/") ? vendor : join(repoRoot(), vendor);
		for (const c of plan.crates) {
			const dir = c.kind === "workspace"
				? join(repoRoot(), "crates", c.crate)
				: join(vendorAbs, c.crate);
			if (!existsSync(dir)) {
				const hint = c.kind === "workspace"
					? `(workspace member directory not found)`
					: `(run 'cargo vendor' first)`;
				console.log(`  skip ${c.crate}: ${dir} does not exist ${hint}`);
				continue;
			}
			const r = applyPlanToVendoredCrate(dir, c);
			console.log(`  ${c.kind === "workspace" ? "[workspace] " : ""}${c.crate}: ${r.totalChanges} edit(s) across ${r.files.length} file(s)`);
		}
	} else {
		console.log("  (rewrite skipped; pass --apply to inject markers into vendored sources)");
		// Provide the snippet on stdout for reviewers.
		process.stdout.write("\n```toml\n" + renderCargoPatchSection(plan) + "```\n");
	}
}

function cmdPatchRevert(): void {
	step("patch revert");
	const before = readFileSync(cargoTomlPath(), "utf8");
	const after = removePatchSection(before);
	if (after !== before) {
		writeFileSync(cargoTomlPath(), after);
		console.log("  removed managed [patch.crates-io] block");
	} else {
		console.log("  no managed [patch.crates-io] block present");
	}
	// Walk every workspace crate dir and strip any leftover per-fn markers
	// + lib-header block. Idempotent: clean repos see zero changes.
	const cratesRoot = join(repoRoot(), "crates");
	if (existsSync(cratesRoot)) {
		let totalReverted = 0;
		let cratesTouched = 0;
		for (const ent of readdirSync(cratesRoot, { withFileTypes: true })) {
			if (!ent.isDirectory()) continue;
			const dir = join(cratesRoot, ent.name);
			const r = revertWorkspaceCrate(dir);
			if (r.totalChanges > 0) {
				cratesTouched++;
				totalReverted += r.totalChanges;
				console.log(`  reverted [workspace] ${ent.name}: ${r.totalChanges} edit(s) across ${r.files.length} file(s)`);
			}
		}
		if (cratesTouched === 0) {
			console.log("  no workspace per-fn markers present");
		} else {
			console.log(`  total: ${totalReverted} edit(s) across ${cratesTouched} workspace crate(s)`);
		}
	}
}

function usage(): never {
	console.error(
		[
			"Usage:",
			"  pgo-run.ts profile  -- <bench-cmd> [args...]",
			"  pgo-run.ts apply    [--profile <path>] [--threshold <0..1>] [--hot-opt-level <lvl>] [--cold-opt-level <lvl>] [--workspace-default <lvl>] [--aggressive-size] [--no-package-overrides] [--always-hot <crate>[,<crate>...]] [--always-cold <crate>[,<crate>...]]",
			"  pgo-run.ts revert",
			"  pgo-run.ts rebuild",
			"  pgo-run.ts validate",
			"  pgo-run.ts report   [--profile <path>] [--threshold <0..1>] [--functions-per-crate <N>] [--top-global <N>]",
			"  pgo-run.ts classify-fns [--profile <path>] [--threshold <0..1>] [--restrict <crate>[,<crate>...]]",
			"  pgo-run.ts bench    --label <name>",
			"  pgo-run.ts bench-compare <baseline.json> <candidate.json>",
			"  pgo-run.ts patch    [--profile <path>] [--threshold <0..1>] [--vendor-root <dir>] [--apply] [--plan-out <file>]",
			"  pgo-run.ts patch-revert",
			"  pgo-run.ts all      [--threshold <0..1>] [--hot-opt-level <lvl>] [--cold-opt-level <lvl>] -- <bench-cmd> [args...]",
		].join("\n")
	);
	exit(2);
}

function isMain(): boolean {
	const url = import.meta.url;
	return Boolean(argv[1] && url === `file://${argv[1]}`);
}

export async function main(args: string[]): Promise<void> {
	const sub = args[0];
	const rest = args.slice(1);
	switch (sub) {
		case "profile": {
			const cmdStart = rest.indexOf("--");
			const cmd = cmdStart === -1 ? rest : rest.slice(cmdStart + 1);
			if (cmd.length === 0) usage();
			cmdProfile(cmd);
			return;
		}
		case "apply": {
			const { profile, opts } = parseApplyOpts(rest);
			const path = profile ?? profilePath(repoRoot(), gitSha());
			cmdApply(path, opts);
			return;
		}
		case "revert":
			cmdRevert();
			return;
		case "rebuild":
			cmdRebuild();
			return;
		case "validate":
			cmdValidate();
			return;
		case "report": {
			const reportOpts: { threshold?: number; functionsPerCrate?: number; topGlobal?: number } = {};
			let profile: string | undefined;
			for (let i = 0; i < rest.length; i++) {
				const a = rest[i];
				if (a === "--profile") profile = rest[++i];
				else if (a === "--threshold") reportOpts.threshold = Number(rest[++i]);
				else if (a === "--functions-per-crate") reportOpts.functionsPerCrate = Number(rest[++i]);
				else if (a === "--top-global") reportOpts.topGlobal = Number(rest[++i]);
			}
			const path = profile ?? profilePath(repoRoot(), gitSha());
			cmdReport(path, reportOpts);
			return;
		}
		case "classify-fns": {
			const fnOpts: { threshold?: number; restrict?: string[] } = {};
			let profile: string | undefined;
			for (let i = 0; i < rest.length; i++) {
				const a = rest[i];
				if (a === "--profile") profile = rest[++i];
				else if (a === "--threshold") fnOpts.threshold = Number(rest[++i]);
				else if (a === "--restrict") fnOpts.restrict = rest[++i].split(",").map(s => s.trim()).filter(Boolean);
			}
			const path = profile ?? profilePath(repoRoot(), gitSha());
			cmdClassifyFunctions(path, fnOpts);
			return;
		}
		case "bench": {
			let label = "default";
			for (let i = 0; i < rest.length; i++) {
				const a = rest[i];
				if (a === "--label") label = rest[++i];
			}
			cmdBench(label);
			return;
		}
		case "bench-compare": {
			if (rest.length < 2) usage();
			cmdBenchCompare(rest[0], rest[1]);
			return;
		}
		case "patch": {
			const patchOpts: PatchOpts = {};
			let profile: string | undefined;
			for (let i = 0; i < rest.length; i++) {
				const a = rest[i];
				if (a === "--profile") profile = rest[++i];
				else if (a === "--threshold") patchOpts.threshold = Number(rest[++i]);
				else if (a === "--vendor-root") patchOpts.vendorRoot = rest[++i];
				else if (a === "--apply") patchOpts.apply = true;
				else if (a === "--plan-out") patchOpts.planOut = rest[++i];
			}
			const path = profile ?? profilePath(repoRoot(), gitSha());
			cmdPatch(path, patchOpts);
			return;
		}
		case "patch-revert":
			cmdPatchRevert();
			return;
		case "all": {
			const cmdStart = rest.indexOf("--");
			const flagsArgs = cmdStart === -1 ? [] : rest.slice(0, cmdStart);
			const cmd = cmdStart === -1 ? rest : rest.slice(cmdStart + 1);
			if (cmd.length === 0) usage();
			const { opts } = parseApplyOpts(flagsArgs);
			const path = cmdProfile(cmd);
			cmdApply(path, opts);
			cmdRebuild();
			cmdValidate();
			return;
		}
		default:
			usage();
	}
}

if (isMain()) {
	main(argv.slice(2)).catch(e => {
		console.error(`pgo-run failed: ${(e as Error).message}`);
		exit(1);
	});
}
