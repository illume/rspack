// Read a stored PGO profile and classify each crate as hot, warm, or cold.
//
// Hot crates → rebuild at opt-level=3 (max speed).
// Cold crates → rebuild at opt-level="z" (smallest code).
//
// Warm bucket exists so we can keep the workspace default (opt-level=3 for
// the [profile.release] block) and only emit explicit overrides for crates
// that should change.
//
// The classifier is pure: input is a profile JSON object, output is a
// per-crate decision. No I/O.

import type { PgoProfile, CrateAggregate } from "./pgo-profile.ts";

export type Decision = "hot" | "cold";

export interface ClassifierOptions {
	/**
	 * Cumulative-share threshold for the hot set, in [0, 1]. The smallest set
	 * of top crates whose summed sample share reaches this fraction is marked
	 * hot. Default 0.85.
	 */
	hotCumulativeShare?: number;
	/**
	 * Crates explicitly forced into the hot bucket (e.g. perf-critical
	 * leaf crates that didn't show up in this run's hot path but that we
	 * never want to size-optimize).
	 */
	alwaysHot?: readonly string[];
	/**
	 * Crates explicitly forced into the cold bucket (e.g. diagnostic
	 * crates we know are cold even if a single benchmark happened to
	 * stress them).
	 */
	alwaysCold?: readonly string[];
	/**
	 * Crates listed in this set are emitted regardless of profile data.
	 * Useful for pinning a known set of workspace crates.
	 */
	candidates?: readonly string[];
}

export interface ClassifiedCrate {
	crate: string;
	decision: Decision;
	samples: number;
	pct: number;
	reason: string;
}

export interface ClassificationResult {
	hot: ClassifiedCrate[];
	cold: ClassifiedCrate[];
}

const DEFAULT_HOT_SHARE = 0.85;

/**
 * Classify crates from a profile into hot / cold buckets.
 *
 * Algorithm:
 *   1. Sort crates by sample count, descending.
 *   2. Walk the list accumulating share; every crate that contributes a
 *      sample share before we cross `hotCumulativeShare` is hot.
 *   3. Apply alwaysHot / alwaysCold overrides last (they win).
 *   4. Optionally extend the result set with `candidates` (assigned cold
 *      unless they were already classified hot).
 */
export function classify(
	profile: PgoProfile,
	opts: ClassifierOptions = {}
): ClassificationResult {
	const share = opts.hotCumulativeShare ?? DEFAULT_HOT_SHARE;
	if (share <= 0 || share > 1) {
		throw new Error(
			`hotCumulativeShare must be in (0, 1], got ${share}`
		);
	}

	const decisions = new Map<string, ClassifiedCrate>();
	let cumulative = 0;
	const sorted: CrateAggregate[] = [...profile.by_crate].sort(
		(a, b) => b.samples - a.samples
	);
	// Normalize against attributable (non-<unknown>) samples so that a large
	// `<unknown>` bucket (kernel/libc/JIT) doesn't make the threshold
	// unreachable and force every crate into the hot set.
	const attributableTotal = sorted
		.filter(c => c.crate !== "<unknown>")
		.reduce((sum, c) => sum + c.pct, 0);
	const norm = attributableTotal > 0 ? attributableTotal : 1;
	for (const c of sorted) {
		if (c.crate === "<unknown>") continue;
		const wasUnderThreshold = cumulative < share;
		cumulative += c.pct / norm;
		decisions.set(c.crate, {
			crate: c.crate,
			decision: wasUnderThreshold ? "hot" : "cold",
			samples: c.samples,
			pct: c.pct,
			reason: wasUnderThreshold
				? `top of profile (cumulative ≤ ${(share * 100).toFixed(0)}%)`
				: "below hot-share threshold",
		});
	}

	for (const cr of opts.alwaysHot ?? []) {
		const existing = decisions.get(cr);
		decisions.set(cr, {
			crate: cr,
			decision: "hot",
			samples: existing?.samples ?? 0,
			pct: existing?.pct ?? 0,
			reason: "force-hot list",
		});
	}
	for (const cr of opts.alwaysCold ?? []) {
		const existing = decisions.get(cr);
		decisions.set(cr, {
			crate: cr,
			decision: "cold",
			samples: existing?.samples ?? 0,
			pct: existing?.pct ?? 0,
			reason: "force-cold list",
		});
	}
	for (const cr of opts.candidates ?? []) {
		if (!decisions.has(cr)) {
			decisions.set(cr, {
				crate: cr,
				decision: "cold",
				samples: 0,
				pct: 0,
				reason: "candidate not seen in profile (defaulting cold)",
			});
		}
	}

	const hot: ClassifiedCrate[] = [];
	const cold: ClassifiedCrate[] = [];
	for (const d of decisions.values()) {
		(d.decision === "hot" ? hot : cold).push(d);
	}
	hot.sort((a, b) => b.samples - a.samples);
	cold.sort((a, b) => b.samples - a.samples);
	return { hot, cold };
}
