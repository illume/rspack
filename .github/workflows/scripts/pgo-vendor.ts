// Selective crate vendoring for the cargo-patch + per-fn `=speed` recipe.
//
// Goal (per user request: "use cargo-patch so we don't need to vendor
// everything"): instead of running `cargo vendor` — which materializes the
// full transitive dependency tree (~1000+ crates, ~1 GiB on disk) into
// `vendor/` — pull only the small set of third-party crates that the
// stored PGO profile actually flags as hot, e.g. `napi`, `serde_json`,
// `hashbrown`, `swc_ecma_*`. Those are the only crates `pgo-patch.ts`
// will inject `#[optimize(speed)]` markers into anyway.
//
// The redirection mechanism is unchanged: `[patch.crates-io] X = { path =
// "vendor/X" }` (already emitted by `renderCargoPatchSection` in
// `pgo-patch.ts`). The extracted crates are byte-identical to what
// `cargo vendor` would produce for those crates — they're the same
// `crates.io` source tarballs.
//
// Why this is a separate tool, rather than `pgo-patch.ts` calling
// `cargo vendor` directly:
//
//   * `cargo vendor` has no "only these crates" mode. The closest knob is
//     the `--sync` flag, which still resolves the *full* dep tree of the
//     synced manifest. To get just `napi` we'd need a throwaway shim
//     manifest, then prune ~1000 sibling directories afterwards.
//   * The crates.io tarball API gives us a deterministic, version-pinned
//     download per crate, so we can vendor exactly what `Cargo.lock`
//     resolved without invoking cargo at all.
//
// What this module does NOT do:
//   * It does not write a `.cargo-checksum.json` per vendored crate. That
//     file is a `cargo vendor` reproducibility artifact, required only
//     when using the `[source.crates-io] replace-with = "vendored"`
//     mechanism. The `[patch.crates-io] X = { path = "..." }` redirection
//     used by `pgo-patch.ts` does **not** require it; cargo treats the
//     path as an ordinary local crate.
//   * It does not attempt to vendor transitive deps of the patched
//     crates. The patched crate's deps continue to resolve via the normal
//     registry index. That is *the entire point* of cargo-patch: it
//     replaces a single node in the dep graph without touching the rest.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { PatchPlan } from "./pgo-patch.ts";

/** ───────────────────────── Cargo.lock parser ────────────────────────── */

/**
 * Look up the resolved version of `name` in a `Cargo.lock` content. The
 * lockfile format is TOML with `[[package]]` arrays; we match the literal
 * `name = "X"` line and pull the next `version = "Y"` line, which is how
 * `cargo` itself emits them. Returns `null` if the package is missing or
 * has multiple distinct resolved versions (in which case the caller has to
 * disambiguate — we don't try to guess which one to vendor).
 */
export function parseLockfileVersion(
	lockContent: string,
	name: string,
): string | null {
	// Normalize CRLF for Windows checkouts (see CI cross-platform memory).
	const text = lockContent.replace(/\r\n/g, "\n");
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// `[[package]]` blocks are separated by blank lines. We match the
	// literal `name = "X"` followed (within a few lines) by `version = "Y"`.
	const re = new RegExp(
		`name = "${escaped}"\\n(?:[^\\n]*\\n){0,4}?version = "([^"]+)"`,
		"g",
	);
	const versions = new Set<string>();
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		versions.add(m[1]);
	}
	if (versions.size === 0) return null;
	if (versions.size > 1) return null;
	return [...versions][0];
}

/** ───────────────────────── tarball download ────────────────────────── */

export interface DownloadOptions {
	/**
	 * Override the crates.io tarball URL builder. Default:
	 * `https://crates.io/api/v1/crates/<name>/<version>/download`.
	 */
	urlFor?: (name: string, version: string) => string;
	/**
	 * Injection point for the actual HTTP fetch. Defaults to a thin
	 * `node:https` wrapper. Tests pass a stub.
	 */
	fetchTarball?: (url: string) => Promise<Uint8Array>;
}

export function defaultTarballUrl(name: string, version: string): string {
	return `https://crates.io/api/v1/crates/${encodeURIComponent(name)}/${encodeURIComponent(version)}/download`;
}

/**
 * Default fetch implementation built on `node:https`. Follows redirects
 * (the crates.io endpoint returns a 302 to a CDN). Kept tiny so we don't
 * pull in a dependency.
 */
export async function defaultFetchTarball(url: string): Promise<Uint8Array> {
	// Lazy-import so unit tests can stub `fetchTarball` without paying the
	// cost of pulling in node:https.
	const { get } = await import("node:https");
	return new Promise<Uint8Array>((resolve, reject) => {
		const req = get(url, { headers: { "user-agent": "pgo-vendor.ts (rspack)" } }, (res) => {
			const status = res.statusCode ?? 0;
			if (status >= 300 && status < 400 && res.headers.location) {
				res.resume();
				defaultFetchTarball(res.headers.location).then(resolve, reject);
				return;
			}
			if (status !== 200) {
				res.resume();
				reject(new Error(`GET ${url} → HTTP ${status}`));
				return;
			}
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
			res.on("error", reject);
		});
		req.on("error", reject);
	});
}

/** ───────────────────────── extract + vendor ────────────────────────── */

export interface VendorCrateOptions {
	/** Crate name (e.g. `"napi"`). */
	name: string;
	/** Resolved version (e.g. `"3.8.5"`). */
	version: string;
	/** Absolute path to write the extracted crate to (e.g. `<repo>/vendor/napi`). */
	destDir: string;
	/** Allow re-extraction over an existing dir (clears it first). Default false. */
	force?: boolean;
	/** Tarball download injection (see `DownloadOptions`). */
	download?: DownloadOptions;
	/**
	 * Injection point for actually writing the .crate tarball + invoking
	 * `tar`. Tests stub this; production uses `defaultExtractTarball`.
	 */
	extract?: (
		tarballBytes: Uint8Array,
		destDir: string,
		opts: { stripComponents: number },
	) => void;
}

export interface VendorCrateResult {
	name: string;
	version: string;
	destDir: string;
	skipped: boolean;
	reason?: string;
}

/**
 * Default extractor: writes the bytes to a temp file and shells out to
 * `tar -xzf` with `--strip-components=1` to drop the
 * `<name>-<version>/` top-level directory the registry adds.
 */
export function defaultExtractTarball(
	bytes: Uint8Array,
	destDir: string,
	opts: { stripComponents: number },
): void {
	mkdirSync(destDir, { recursive: true });
	const tmpFile = join(
		tmpdir(),
		`pgo-vendor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.crate`,
	);
	writeFileSync(tmpFile, bytes);
	try {
		execFileSync(
			"tar",
			[
				"-xzf",
				tmpFile,
				"-C",
				destDir,
				`--strip-components=${opts.stripComponents}`,
			],
			{ stdio: "pipe" },
		);
	} finally {
		try {
			rmSync(tmpFile, { force: true });
		} catch {
			/* best-effort cleanup */
		}
	}
}

/**
 * Vendor a single crate from crates.io into `destDir`. Returns
 * `{ skipped: true }` if `destDir/Cargo.toml` already exists and `force`
 * is not set — keeps the operation idempotent so re-running the recipe
 * doesn't re-download.
 */
export async function vendorCrateFromCratesIo(
	opts: VendorCrateOptions,
): Promise<VendorCrateResult> {
	const { name, version, destDir, force, download, extract } = opts;
	const cargoToml = join(destDir, "Cargo.toml");
	if (!force && existsSync(cargoToml)) {
		return {
			name,
			version,
			destDir,
			skipped: true,
			reason: "destination already populated (Cargo.toml present)",
		};
	}
	if (force && existsSync(destDir)) {
		rmSync(destDir, { recursive: true, force: true });
	}
	const urlFor = download?.urlFor ?? defaultTarballUrl;
	const fetchTarball = download?.fetchTarball ?? defaultFetchTarball;
	const url = urlFor(name, version);
	const bytes = await fetchTarball(url);
	(extract ?? defaultExtractTarball)(bytes, destDir, { stripComponents: 1 });
	if (!existsSync(cargoToml)) {
		throw new Error(
			`vendor extract failed for ${name}@${version}: ${cargoToml} missing after extraction`,
		);
	}
	return { name, version, destDir, skipped: false };
}

/** ───────────────────────── plan driver ────────────────────────── */

export interface VendorFromPlanOptions {
	/** Workspace root (where `Cargo.lock` lives). */
	repoRoot: string;
	/** Force re-download even if `vendor/<crate>/Cargo.toml` exists. */
	force?: boolean;
	/** Lockfile content override; default reads `<repoRoot>/Cargo.lock`. */
	lockContent?: string;
	/** Tarball download injection (see `DownloadOptions`). */
	download?: DownloadOptions;
	/** Extractor injection (see `VendorCrateOptions.extract`). */
	extract?: VendorCrateOptions["extract"];
	/**
	 * For test injection: override the per-crate vendor entrypoint. Defaults
	 * to `vendorCrateFromCratesIo`.
	 */
	vendorOne?: (o: VendorCrateOptions) => Promise<VendorCrateResult>;
}

export interface VendorPlanResult {
	results: VendorCrateResult[];
	skipped: { crate: string; reason: string }[];
}

/**
 * Walk the patch plan and vendor every third-party crate. Workspace
 * crates are skipped (they already live at `crates/<name>/`). Crates whose
 * version cannot be resolved from `Cargo.lock` are skipped with a
 * structured reason — surfacing instead of guessing.
 */
export async function vendorCratesFromPlan(
	plan: PatchPlan,
	opts: VendorFromPlanOptions,
): Promise<VendorPlanResult> {
	const lock = opts.lockContent ?? readFileSync(join(opts.repoRoot, "Cargo.lock"), "utf8");
	const vendorRoot = plan.vendor_root || "vendor";
	const vendorAbs = vendorRoot.startsWith("/") ? vendorRoot : join(opts.repoRoot, vendorRoot);
	const vendorOne = opts.vendorOne ?? vendorCrateFromCratesIo;

	const results: VendorCrateResult[] = [];
	const skipped: { crate: string; reason: string }[] = [];

	for (const c of plan.crates) {
		if (c.kind === "workspace") {
			skipped.push({
				crate: c.crate,
				reason: "workspace member (no vendoring needed)",
			});
			continue;
		}
		const version = parseLockfileVersion(lock, c.crate);
		if (!version) {
			skipped.push({
				crate: c.crate,
				reason: "no unique version found in Cargo.lock",
			});
			continue;
		}
		const destDir = join(vendorAbs, c.crate);
		const r = await vendorOne({
			name: c.crate,
			version,
			destDir,
			force: opts.force,
			download: opts.download,
			extract: opts.extract,
		});
		results.push(r);
	}
	return { results, skipped };
}
