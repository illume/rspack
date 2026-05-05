// Locates the `.node` binding produced by `pnpm build:binding:release`,
// records its on-disk size both as-built and after running an extra
// `strip --strip-all` pass, and writes a self-describing `size-report.json`
// so a future analysis session can consume results without any other context.

import {
	copyFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { argv, env, exit, platform as nodePlatform } from "node:process";

export interface SizeReport {
	schema_version: 1;
	platform: string;
	runner_os: string;
	variant: string;
	node_file: string;
	raw_size_bytes: number;
	stripped_size_bytes: number | null;
	strip_tool: string | null;
	git_sha: string;
	git_ref: string;
	run_id: string;
	run_url: string;
	rustc_version: string;
}

export interface MeasureOptions {
	/** Directory containing the `.node` artifact(s). */
	bindingDir: string;
	/** Logical platform label (`linux-x64-gnu`, `darwin-arm64`, `win32-x64-msvc`). */
	platform: string;
	/** GitHub `RUNNER_OS` value (`Linux`, `macOS`, `Windows`). */
	runnerOs: string;
	variant: string;
	/** GitHub-provided env values; injected for testability. */
	githubEnv?: Partial<Record<"GITHUB_SHA" | "GITHUB_REF" | "GITHUB_RUN_ID" | "GITHUB_REPOSITORY" | "GITHUB_SERVER_URL", string>>;
	rustcVersion?: string;
}

/** Locate the first `*.node` file in `dir`. Throws if none found. */
export function findNodeArtifact(dir: string): string {
	const files = readdirSync(dir).filter(f => f.endsWith(".node")).sort();
	if (files.length === 0) {
		throw new Error(`no .node file found under ${dir}`);
	}
	return join(dir, files[0]);
}

/**
 * Try to run `strip` on a copy of `nodeFile` and return the resulting size +
 * tool description. Returns `[null, null]` if stripping is unsupported (e.g.
 * Windows) or fails (e.g. file is not a real ELF/Mach-O).
 */
export function tryExtraStrip(
	nodeFile: string,
	runnerOs: string
): [number | null, string | null] {
	const tmp = nodeFile + ".stripped";
	let cmd: [string, string[]] | null = null;
	switch (runnerOs) {
		case "Linux":
			cmd = ["strip", ["--strip-all", tmp]];
			break;
		case "macOS":
			cmd = ["strip", ["-x", tmp]];
			break;
		case "Windows":
		default:
			return [null, null];
	}
	try {
		copyFileSync(nodeFile, tmp);
		execFileSync(cmd[0], cmd[1], { stdio: "pipe" });
		const size = statSync(tmp).size;
		const tool =
			runnerOs === "Linux"
				? "strip --strip-all (binutils)"
				: "strip -x (cctools)";
		return [size, tool];
	} catch {
		return [null, null];
	} finally {
		try {
			rmSync(tmp, { force: true });
		} catch {
			/* ignore */
		}
	}
}

export function measure(opts: MeasureOptions): SizeReport {
	const nodeFile = findNodeArtifact(opts.bindingDir);
	const rawSize = statSync(nodeFile).size;
	const [strippedSize, stripTool] = tryExtraStrip(nodeFile, opts.runnerOs);

	const ge = opts.githubEnv ?? env;
	const sha = ge.GITHUB_SHA ?? "unknown";
	const ref = ge.GITHUB_REF ?? "unknown";
	const runId = ge.GITHUB_RUN_ID ?? "unknown";
	const repo = ge.GITHUB_REPOSITORY ?? "unknown";
	const server = ge.GITHUB_SERVER_URL ?? "https://github.com";

	return {
		schema_version: 1,
		platform: opts.platform,
		runner_os: opts.runnerOs,
		variant: opts.variant,
		node_file: nodeFile.split(/[\\/]/).pop()!,
		raw_size_bytes: rawSize,
		stripped_size_bytes: strippedSize,
		strip_tool: stripTool,
		git_sha: sha,
		git_ref: ref,
		run_id: runId,
		run_url: `${server}/${repo}/actions/runs/${runId}`,
		rustc_version: opts.rustcVersion ?? "",
	};
}

function detectRunnerOs(): string {
	if (env.RUNNER_OS) return env.RUNNER_OS;
	switch (nodePlatform) {
		case "linux":
			return "Linux";
		case "darwin":
			return "macOS";
		case "win32":
			return "Windows";
		default:
			return "Unknown";
	}
}

function getRustcVersion(): string {
	try {
		return execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim();
	} catch {
		return "";
	}
}

function isMain(): boolean {
	return !!argv[1] && argv[1].endsWith("binary-size-measure.ts");
}

if (isMain()) {
	const variant = env.VARIANT;
	const platform = env.PLATFORM;
	if (!variant || !platform) {
		console.error("::error::VARIANT and PLATFORM env vars are required");
		exit(2);
	}
	try {
		const report = measure({
			bindingDir: "crates/node_binding",
			platform,
			runnerOs: detectRunnerOs(),
			variant,
			rustcVersion: getRustcVersion(),
		});
		writeFileSync("size-report.json", JSON.stringify(report, null, 2));
		const human = (n: number | null) =>
			n === null ? "—" : `${(n / 1024 / 1024).toFixed(2)} MiB`;
		console.log(
			`platform=${report.platform} variant=${report.variant} ` +
				`raw=${human(report.raw_size_bytes)} stripped=${human(report.stripped_size_bytes)}`
		);
		console.log("----- size-report.json -----");
		console.log(JSON.stringify(report, null, 2));
		console.log("----------------------------");
	} catch (err) {
		console.error(`::error::${(err as Error).message}`);
		exit(1);
	}
}
