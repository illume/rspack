// Patches Cargo.toml and/or crates/node_binding/scripts/build.js to flip a
// single binary-size optimization knob.
//
// Designed to run on Node ≥ 22 with native TypeScript support (no compile
// step). All public functions are exported for unit testing.
//
// Variants — kept in sync with .github/workflows/binary-size-experiment.yml:
//   baseline             — no patch
//   opt-level-s-global   — [profile.release].opt-level = "s"
//   opt-level-z-global   — [profile.release].opt-level = "z"
//   lto-thin             — [profile.release].lto       = "thin"
//   lto-off              — [profile.release].lto       = "off"
//   no-build-std         — drop -Zbuild-std=panic_abort,std from build.js
//   no-info-level        — drop the `info-level` feature push from build.js

import { readFileSync, writeFileSync } from "node:fs";
import { argv, exit, env } from "node:process";

export const VARIANTS = [
	"baseline",
	"opt-level-s-global",
	"opt-level-z-global",
	"lto-thin",
	"lto-off",
	"no-build-std",
	"no-info-level",
] as const;

export type Variant = (typeof VARIANTS)[number];

export function isVariant(s: string): s is Variant {
	return (VARIANTS as readonly string[]).includes(s);
}

/**
 * Replace a single key under the [profile.release] section of a workspace
 * Cargo.toml without touching per-package overrides under
 * [profile.release.package.*]. Returns the new file contents.
 *
 * Throws if the section or key is not found.
 */
export function patchReleaseKey(
	src: string,
	key: string,
	newValue: string
): string {
	// Section body = everything from `[profile.release]\n` up to the next
	// top-level `[...]` header. Crucially, this stops at `[profile.release.package.*]`.
	const sectionRe = /(?<header>^\[profile\.release\]\n)(?<body>[\s\S]*?)(?=^\[)/m;
	const m = src.match(sectionRe);
	if (!m || !m.groups) {
		throw new Error("[profile.release] not found");
	}
	const body = m.groups.body;
	// Match `key = <value>[whitespace][comment]`. Value can be a quoted
	// string ("...") or a bare token (3, true, ...).
	const keyRe = new RegExp(
		String.raw`(?<lead>^\s*${escapeRe(key)}\s*=\s*)(?:"[^"]*"|\S+)(?<trail>\s*(?:#.*)?)$`,
		"m"
	);
	if (!keyRe.test(body)) {
		throw new Error(`key ${key} not found under [profile.release]`);
	}
	const newBody = body.replace(keyRe, `$<lead>"${newValue}"$<trail>`);
	const start = m.index! + m.groups.header.length;
	return src.slice(0, start) + newBody + src.slice(start + body.length);
}

/**
 * Remove a single line from build.js whose substring matches `needle`.
 * Used to delete `args.push(...)` or `features.push(...)` calls.
 *
 * Throws if no matching line is found.
 */
export function dropBuildJsLine(src: string, needle: string): string {
	const lines = src.split("\n");
	const idx = lines.findIndex(l => l.includes(needle));
	if (idx === -1) {
		throw new Error(`line containing ${JSON.stringify(needle)} not found in build.js`);
	}
	lines.splice(idx, 1);
	return lines.join("\n");
}

/**
 * Apply the patch for `variant` to the in-memory Cargo.toml / build.js
 * contents. Returns the new contents (only the file the variant touches is
 * modified; the other is returned unchanged).
 */
export function applyVariant(
	variant: Variant,
	cargoToml: string,
	buildJs: string
): { cargoToml: string; buildJs: string } {
	switch (variant) {
		case "baseline":
			return { cargoToml, buildJs };
		case "opt-level-s-global":
			return { cargoToml: patchReleaseKey(cargoToml, "opt-level", "s"), buildJs };
		case "opt-level-z-global":
			return { cargoToml: patchReleaseKey(cargoToml, "opt-level", "z"), buildJs };
		case "lto-thin":
			return { cargoToml: patchReleaseKey(cargoToml, "lto", "thin"), buildJs };
		case "lto-off":
			return { cargoToml: patchReleaseKey(cargoToml, "lto", "off"), buildJs };
		case "no-build-std":
			return {
				cargoToml,
				buildJs: dropBuildJsLine(buildJs, '"-Zbuild-std=panic_abort,std"'),
			};
		case "no-info-level":
			return {
				cargoToml,
				buildJs: dropBuildJsLine(buildJs, 'features.push("info-level")'),
			};
	}
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CARGO_PATH = "Cargo.toml";
const BUILD_JS_PATH = "crates/node_binding/scripts/build.js";

// Run-as-script entry point.
function isMain(): boolean {
	// Node sets argv[1] to the script path. URL-decoded resolved path
	// comparison is overkill here — substring is enough.
	return !!argv[1] && argv[1].endsWith("binary-size-apply-variant.ts");
}

if (isMain()) {
	const variant = env.VARIANT ?? "";
	if (!isVariant(variant)) {
		console.error(`::error::unknown VARIANT: ${JSON.stringify(variant)}`);
		exit(2);
	}
	const cargoBefore = readFileSync(CARGO_PATH, "utf8");
	const buildJsBefore = readFileSync(BUILD_JS_PATH, "utf8");
	try {
		const { cargoToml, buildJs } = applyVariant(
			variant,
			cargoBefore,
			buildJsBefore
		);
		if (cargoToml !== cargoBefore) writeFileSync(CARGO_PATH, cargoToml);
		if (buildJs !== buildJsBefore) writeFileSync(BUILD_JS_PATH, buildJs);
		if (variant === "baseline") {
			console.log("::notice::variant=baseline (no patch applied)");
		} else {
			console.log(`::notice::variant=${variant} applied`);
		}
	} catch (err) {
		console.error(`::error::failed to apply variant ${variant}: ${(err as Error).message}`);
		exit(1);
	}
}
