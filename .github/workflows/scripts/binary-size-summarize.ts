// Aggregate per-job size-report.json files into a single markdown summary
// table and a combined JSON document for offline analysis.
//
// Runs on Node ≥ 22 with native TypeScript support; importable for tests.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argv, exit } from "node:process";

import type { SizeReport } from "./binary-size-measure.ts";

export const VARIANT_ORDER = [
	"baseline",
	"opt-level-s-global",
	"opt-level-z-global",
	"lto-thin",
	"lto-off",
	"no-build-std",
	"no-info-level",
];

export function fmtBytes(n: number | null): string {
	if (n === null || n === undefined) return "—";
	if (n < 1024) return `${n.toLocaleString("en-US")} B`;
	const units = ["KiB", "MiB", "GiB"];
	let f = n / 1024;
	for (const u of units) {
		if (f < 1024 || u === units[units.length - 1]) {
			return `${f.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${u}`;
		}
		f /= 1024;
	}
	return `${n} B`;
}

export function fmtDelta(cur: number, base: number): string {
	if (base === 0) return "—";
	const diff = cur - base;
	const pct = (100.0 * diff) / base;
	const sign = diff >= 0 ? "+" : "";
	const diffStr = diff.toLocaleString("en-US");
	return `${sign}${diffStr} B (${sign}${pct.toFixed(2)}%)`;
}

/** Walk `dir` recursively and return every `*.json` path. */
export function findJsonFiles(dir: string): string[] {
	const out: string[] = [];
	const stack = [dir];
	while (stack.length > 0) {
		const cur = stack.pop()!;
		let entries: string[];
		try {
			entries = readdirSync(cur);
		} catch {
			continue;
		}
		for (const name of entries) {
			const p = join(cur, name);
			let st;
			try {
				st = statSync(p);
			} catch {
				continue;
			}
			if (st.isDirectory()) stack.push(p);
			else if (st.isFile() && name.endsWith(".json")) out.push(p);
		}
	}
	return out.sort();
}

export function summarize(reports: SizeReport[]): string {
	if (reports.length === 0) {
		return "# Binary size experiment\n\n_No reports found._";
	}

	const byPlatform = new Map<string, SizeReport[]>();
	for (const r of reports) {
		const list = byPlatform.get(r.platform) ?? [];
		list.push(r);
		byPlatform.set(r.platform, list);
	}

	const variantKey = (r: SizeReport): [number, string] => {
		const idx = VARIANT_ORDER.indexOf(r.variant);
		return [idx === -1 ? VARIANT_ORDER.length : idx, r.variant];
	};

	const out: string[] = [];
	out.push("# Binary size experiment\n");
	out.push(
		"Each row is one CI job that built `crates/node_binding/*.node` with " +
			"a single optimization knob flipped. `Δ vs baseline` is computed " +
			"per-platform against the `baseline` row of that platform.\n"
	);

	const anySha = reports.find(r => r.git_sha)?.git_sha;
	const anyUrl = reports.find(r => r.run_url)?.run_url;
	if (anySha) out.push(`- Commit: \`${anySha}\``);
	if (anyUrl) out.push(`- Run: ${anyUrl}`);
	out.push("");

	for (const platform of [...byPlatform.keys()].sort()) {
		const rows = (byPlatform.get(platform) ?? []).slice().sort((a, b) => {
			const [ai, av] = variantKey(a);
			const [bi, bv] = variantKey(b);
			return ai !== bi ? ai - bi : av.localeCompare(bv);
		});
		const baseline = rows.find(r => r.variant === "baseline");
		out.push(`## \`${platform}\`\n`);
		out.push(
			"| Variant | Raw size | Δ vs baseline | After extra `strip` | Δ vs raw |"
		);
		out.push("| --- | ---: | ---: | ---: | ---: |");
		for (const r of rows) {
			const raw = r.raw_size_bytes;
			const stripped = r.stripped_size_bytes;
			const deltaBase = !baseline
				? "—"
				: r === baseline
					? "0 B (baseline)"
					: fmtDelta(raw, baseline.raw_size_bytes);
			const deltaStrip = stripped !== null && stripped !== undefined ? fmtDelta(stripped, raw) : "—";
			out.push(
				`| \`${r.variant}\` | ${fmtBytes(raw)} | ${deltaBase} | ${fmtBytes(stripped)} | ${deltaStrip} |`
			);
		}
		out.push("");
	}

	out.push("---");
	out.push("");
	out.push(
		"The full per-job JSON reports plus a `combined-size-reports.json` " +
			"document are uploaded as the `binary-size-experiment-results` " +
			"artifact for offline analysis."
	);

	return out.join("\n");
}

function isMain(): boolean {
	return !!argv[1] && argv[1].endsWith("binary-size-summarize.ts");
}

if (isMain()) {
	const dir = argv[2] ?? "reports";
	const files = findJsonFiles(dir);
	const reports: SizeReport[] = [];
	for (const f of files) {
		try {
			reports.push(JSON.parse(readFileSync(f, "utf8")));
		} catch (err) {
			console.error(`<!-- skipped ${f}: ${(err as Error).message} -->`);
		}
	}

	writeFileSync(
		"combined-size-reports.json",
		JSON.stringify({ schema_version: 1, reports }, null, 2)
	);

	console.log(summarize(reports));
	exit(0);
}
