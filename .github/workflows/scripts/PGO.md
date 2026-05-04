# Profile-Guided opt-level overrides (`pgo-*`)

A small toolchain for the **profile → store → read → optimize → rebuild → validate**
loop on the Rspack Node binding. Lets us compile the hot path at
`opt-level = 3` and the cold path at `opt-level = "z"` based on real perf
samples instead of guesswork.

> **Note**: Despite the name, this is **not** Rust's built-in PGO
> (`-Cprofile-generate=` / `-Cprofile-use=`). It's a coarser, per-crate
> opt-level tuning loop that is much cheaper to maintain (no profdata
> binary format, no instrumented build) and that targets a different
> trade-off — **binary size at fixed throughput**, not raw throughput.

## Files

| File | Role |
| --- | --- |
| `pgo-profile.ts` | Run `perf record` + `perf script`, parse, attribute samples to crates, write `perf_profiles/<sha>.json` |
| `pgo-classify.ts` | Read a profile, classify each crate as `hot` (top of cumulative-share threshold) or `cold` |
| `pgo-classify-functions.ts` | Function-level classifier: same algorithm but operating on `top_symbols` to identify per-function hot/cold candidates for source-level annotation (`#[inline]` / `#[cold]` / nightly `#[optimize(speed|size)]`) |
| `pgo-apply-overrides.ts` | Write a managed `[profile.release.package.<crate>]` block into the workspace `Cargo.toml` |
| `pgo-patch.ts` | Cargo-patch + source rewriter: vendors third-party crates via `[patch.crates-io]`, defaults each to `#[optimize(size)]`, lifts hot fns back to `#[optimize(speed)]` (nightly `optimize_attribute`). Driven by the same profile JSON; idempotent via `// pgo-managed` sentinels |
| `pgo-report.ts` | Render the **function-level** view of a stored profile: hot functions inside each hot crate, plus a global top-N hot-functions table with cumulative share |
| `pgo-run.ts` | Driver that orchestrates the full loop |
| `pgo.test.ts` | Unit tests (run with `node --experimental-strip-types --test`) |

All scripts run on Node ≥ 22 with native TypeScript (no compile step).

## JSON schema

```jsonc
// perf_profiles/<commit-sha>.json
{
  "schema_version": 1,
  "git_sha": "deadbeef…",
  "created_at": "2026-05-03T16:45:00.000Z",
  "rustc_version": "rustc 1.99.0-nightly (… 2026-04-16)",
  "command": "./target/release/bench --iters 100",
  "total_samples": 123456,
  "by_crate": [
    { "crate": "rspack_core",    "samples": 50000, "pct": 0.405 },
    { "crate": "swc_ecma_parser", "samples": 20000, "pct": 0.162 },
    { "crate": "<unknown>",       "samples":  5000, "pct": 0.040 }
  ],
  "top_symbols": [
    { "symbol": "rspack_core::module::Module::build", "crate": "rspack_core", "samples": 12345 }
  ]
}
```

The file is committed-or-not at the user's discretion. The `git_sha` field
makes it self-identifying so it's safe to keep many side-by-side.

## End-to-end usage

The driver `pgo-run.ts` exposes `profile`, `apply`, `revert`, `rebuild`,
`validate`, and `all`. Typical flow:

```bash
# 1. Run a representative benchmark under perf and store the profile.
#    Anything that exercises the binding works — ts-react.bench.ts is one
#    option; a real project build is even better.
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts \
  profile -- node tests/bench/ts-react.bench.ts

# 2. Classify crates and write the managed block into Cargo.toml.
#    Re-runnable at any time; the block is delimited by sentinel comments
#    so it never disturbs hand-written [profile.release.package.*] sections.
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts apply

# 3. Rebuild the binding with the new per-crate opt-levels.
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts rebuild

# 4. Validate the artifact exists. (Re-run your benchmark afterwards
#    to confirm perf has not regressed.)
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts validate

# Or do all four in one shot:
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts \
  all -- node tests/bench/ts-react.bench.ts

# Undo: strip the managed block (keeps any hand-written overrides).
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts revert
```

## Aggressive-size mode (`--aggressive-size`)

The default loop above keeps the workspace at `opt-level = 3` and only
*demotes* the cold tail to `"z"`. That's conservative — it recovers
roughly a third of the global-`z` size win at no perf cost.

To go further — **`opt-level = "z"` everywhere except the hot path,
including third-party crates** — pass `--aggressive-size`:

```bash
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts \
  apply --aggressive-size --threshold 0.95
```

This:

1. Rewrites the workspace `[profile.release].opt-level = 3` line to
   `opt-level = "z"`, tagging the original value in a
   `# pgo-managed-original-opt-level=3` sentinel comment so `revert`
   restores it byte-for-byte.
2. Emits `[profile.release.package.<crate>] opt-level = 3` for every
   classified hot crate, including third-party crates (`swc_ecma_*`,
   `hashbrown`, `indexmap`, `hstr`, …). Cargo applies `[profile.release.package.X]`
   to dependency crates exactly the same as workspace crates.
3. Skips any crate that already has a hand-written
   `[profile.release.package.X]` table to avoid TOML duplicate-key errors.

`revert` reverses both halves (managed block + workspace opt-level).

The `--workspace-default <lvl>`, `--hot-opt-level <lvl>`, and
`--cold-opt-level <lvl>` flags are also independently composable if you
want a different split (e.g. workspace `"s"`, hot `3`, cold `"z"`).

## Cargo-patch + source-level markers (`pgo-run.ts patch`)

Cargo's `[profile.release.package.X]` is **package-granular**: the smallest
unit it can target is a whole crate. To go finer than that — keep
`Pure::visit_mut_expr` at full speed while shrinking every cold helper
inside `swc_ecma_minifier` — the only mechanism Rust offers is **source
attributes** (`#[optimize(speed)]` / `#[optimize(size)]`, nightly behind
`#![feature(optimize_attribute)]`). For third-party crates we can't edit
upstream, but we can vendor + override them via `[patch.crates-io]`.

`pgo-run.ts patch` automates that loop end-to-end:

1. **Read** the stored `perf_profiles/<sha>.json`.
2. **Classify** every `top_symbol` as hot/cold using the same cumulative-
   share algorithm as the crate-level classifier (default threshold 0.5
   inside the function-level pass — see `pgo-classify-functions.ts`).
3. **Group** hot/cold functions by their attributed crate. Drop any crate
   that has no hot symbol — the existing crate-level pass already handles
   pure-cold crates better.
4. **Write** a managed `[patch.crates-io]` block into the workspace
   `Cargo.toml`, pointing each remaining crate at `vendor/<crate>` (path
   is configurable via `--vendor-root`). Block is delimited by
   `# >>> pgo-managed-patch-crates-io >>>` / `# <<< … <<<` sentinels and
   is removed byte-identically by `pgo-run.ts patch-revert`.
5. **Optionally rewrite** the vendored sources (`--apply`) to inject:
   - At each crate's `src/lib.rs`:
     ```rust
     #![feature(optimize_attribute)]
     ```
     This is the **only** crate-root attribute we emit. `#[optimize]` is
     fn-only on nightly (rustc rejects `#![cfg_attr(..., optimize(size))]`
     at the crate root with "`#[optimize]` can only be applied to
     functions"). The crate-wide size default is delivered instead by a
     `[profile.release.package.<crate>] opt-level = "z"` block emitted
     into the same managed region of `Cargo.toml`.
   - Above each hot fn signature: `#[optimize(speed)] // pgo-managed`,
     lifting just that fn back to speed codegen.
   - Above each cold fn signature: `#[optimize(size)] // pgo-managed` —
     redundant with the crate-level `opt-level = "z"`, but kept explicit
     so the intent is grep-able and the rewrite is verifiable.
   - The rewriter skips fn signatures that end in `;` rather than `{`
     (required trait methods, `extern` declarations) — `#[optimize]` is
     also rejected on those by rustc.
   The sentinel `// pgo-managed` makes the rewrite **idempotent**: re-runs
   recognise their own work and don't double-insert.

### Recipe

```bash
# 0. Build/refresh a profile against the bench harness.
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts \
    profile -- target/release/bench

# 1. Materialise vendored sources so the [patch.crates-io] paths exist.
cargo vendor --versioned-dirs vendor

# 2. Generate plan + write [patch.crates-io] + inject markers in vendor/.
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts \
    patch --profile perf_profiles/<sha>.json --threshold 0.5 \
          --vendor-root vendor --apply --plan-out perf_profiles/<sha>.patch-plan.json

# 3. Rebuild — release build flags pin nightly already, so the
#    `optimize_attribute` feature gate is satisfied.
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts rebuild
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts validate

# 4. Bench it against the baseline.
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts bench --label patched
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts \
    bench-compare perf_profiles/bench-<sha>-baseline.json perf_profiles/bench-<sha>-patched.json

# 5. Roll back when done.
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts patch-revert
```

### What the plan looks like on the committed profile

Run against `perf_profiles/bb4b6f7e2acf423926145b94eb1bea19801ee4c9.json` at
`--threshold 0.5`: **8 third-party crates** patched, **18 hot fns** marked
`#[optimize(speed)]`, **44 cold fns** marked `#[optimize(size)]`. Top
crates by attributable share: `swc_ecma_minifier`, `swc_ecma_ast`,
`swc_ecma_parser`, `swc_ecma_utils`, `swc_ecma_transforms_base`,
`swc_ecma_transforms_optimization`, `hstr`, `hashbrown`. The full plan is
emitted as Markdown on stdout and (with `--plan-out`) as JSON.

### Empirical run on the actual binding (cargo-patch + per-fn markers)

Built and benched on the actual `rspack.linux-x64-gnu.node` with the
production release flags + `nightly-2026-04-16` (`lto="fat"`, `cgu=1`,
`strip=true`, `panic="abort"`, `-Zbuild-std=panic_abort,std`,
`-Cforce-unwind-tables=no`, `--features plugin,info-level`). The two
builds use the same source tree; the candidate adds a managed
`[patch.crates-io]` + `[profile.release.package.X] opt-level = "z"` block
covering the 8 hot crates plus rewritten `vendor/<crate>/src/**/*.rs`
with `#[optimize(speed)]` on 18 hot fns and `#[optimize(size)]` on 44
cold fns inside those same crates.

| Variant | `.node` bytes | MiB | Δ size | Build time | Median runtime Δ (9 vitest benches) |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline (`opt-level = 3`) | 53,007,144 | 50.55 | — | 13m49s | — |
| **patch-cargo-fns** (8 crates `=z` + 18 hot fns `=speed` + 44 cold fns `=size`) | **51,558,696** | **49.17** | **−2.73%** | **13m12s** | **−1.53%** (mean −1.08%, **faster**) |

Per-benchmark deltas (negative = candidate faster):

| Benchmark | Baseline (ms) | patch-cargo-fns (ms) | Δ |
| --- | ---: | ---: | ---: |
| Traverse module graph by dependencies | 0.110 | 0.112 | +1.73% |
| Traverse module graph by connections | 0.021 | 0.021 | **−1.87%** |
| Traverse compilation.modules | 0.003 | 0.003 | **−3.33%** |
| stats.toJson() | 3.449 | 3.463 | +0.39% |
| collect imported identifiers | 0.013 | 0.013 | **−1.53%** |
| record module | 0.067 | 0.068 | +2.71% |
| is css mod | 0.004 | 0.004 | **−2.38%** |
| record chunk group | 0.002 | 0.002 | +4.55% |
| external getResolve | 0.173 | 0.156 | **−9.94%** |

**Read.** Compared to `apply --aggressive-size --threshold 0.95` (which
flips the workspace default to `=z` and pins 18+ crates back at `=3` via
`[profile.release.package.X]`, giving −24.65% size for **+5.56%** runtime
cost), the cargo-patch + per-fn approach trades most of the size win for
all of the runtime preservation: −2.73% size, −1.53% runtime — both
moving in the right direction. Mechanism: only 8 crates participate, the
rest of the binary (~95 crates) stays at workspace `opt-level = 3`, fat-
LTO still inlines the hot fn bodies (which carry `#[optimize(speed)]`)
into their callers, and only the cold helpers inside those 8 crates
shrink. Compose with `apply --aggressive-size` for the larger size win
on the long tail (see "What this composes with" above).

Bench JSON files committed:
- `perf_profiles/bench-a70f60a8ef14d63d6fe2f2c5bd045c6e5fb965dd-baseline-v2.json`
- `perf_profiles/bench-a70f60a8ef14d63d6fe2f2c5bd045c6e5fb965dd-patch-cargo-fns.json`

Reproducer:

```bash
# Baseline
pnpm run build:binding:release
cp crates/node_binding/rspack.linux-x64-gnu.node /tmp/baseline.node
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts \
    bench --label baseline-v2

# Patched
mkdir -p vendor && for v in \
  swc_ecma_minifier-52.0.2:swc_ecma_minifier \
  swc_ecma_ast-23.0.0:swc_ecma_ast \
  swc_ecma_parser-39.0.1:swc_ecma_parser \
  swc_ecma_utils-29.1.0:swc_ecma_utils \
  swc_ecma_transforms_base-42.0.0:swc_ecma_transforms_base \
  swc_ecma_transforms_optimization-44.0.0:swc_ecma_transforms_optimization \
  hstr-3.0.3:hstr hashbrown-0.16.1:hashbrown
do
  src=${v%%:*}; dst=${v##*:}
  cp -r ~/.cargo/registry/src/index.crates.io-*/$src vendor/$dst
  chmod -R u+w vendor/$dst
done
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts \
    patch --profile perf_profiles/bb4b6f7e2acf423926145b94eb1bea19801ee4c9.json \
          --threshold 0.5 --apply
pnpm run build:binding:release
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts \
    bench --label patch-cargo-fns
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts \
    bench-compare \
        perf_profiles/bench-<sha>-baseline-v2.json \
        perf_profiles/bench-<sha>-patch-cargo-fns.json
```

(`hashbrown` is multi-version in the Cargo.lock — 0.12.3, 0.14.5, 0.15.2,
0.16.1; the patch only matches `^0.16` paths, the older versions keep
using crates.io. Same shape if you choose to vendor only some versions.)

### Empirical run on the actual binding (workspace `=z` + per-fn `=speed`)

Same `rspack.linux-x64-gnu.node` build as above; **only** difference is
the workspace `[profile.release].opt-level` is flipped to `"z"` (so all
~95 workspace + dependency crates default to size) **without** any
`[profile.release.package.X]` pin-back. The same per-fn
`#[optimize(speed)]` markers from the cargo-patch step are kept on the
18 hot fns inside the 8 patched crates. This is the natural
"size-everywhere except proven hot fns" composition.

Driven by the new `apply --no-package-overrides` flag:

```bash
# Workspace knob only — no managed [profile.release.package.X] block.
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts \
    apply --profile perf_profiles/<sha>.json \
          --workspace-default z --no-package-overrides
# Per-fn speed markers via cargo-patch (unchanged).
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts \
    patch --profile perf_profiles/<sha>.json --threshold 0.5 --apply
pnpm run build:binding:release
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts \
    bench --label workspace-z-fns-speed
```

| Variant | `.node` bytes | MiB | Δ size | Build time | Median runtime Δ |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline-v3 (`opt-level = 3`) | 53,007,144 | 50.55 | — | 17m06s | — |
| **workspace-z-fns-speed** (workspace `=z` + 18 hot fns `=speed`) | **36,824,872** | **35.12** | **−30.53%** | **13m45s** | **+5.56%** (mean +9.60%) |

For reference: `aggressive-z-95` (workspace `=z` + 18 hot **crates** at
`=3`) produced 39.9 MiB / −24.65% size at the same +5.56% median runtime
cost on a different SHA. The combined `workspace-z-fns-speed` mode beats
that by ~3 MiB more savings (−30.53% vs −24.65%) at identical median
runtime, because per-fn `#[optimize(speed)]` markers keep just the 18
hot fn bodies at speed codegen instead of the entire 18 hot crates.
Mean runtime is +9.60% — driven mostly by `Traverse module graph by
dependencies` (+30.57%); the other 8 benches are within +0–16%.

Per-bench deltas (negative = candidate faster):

| Benchmark | Baseline-v3 (ms) | workspace-z-fns-speed (ms) | Δ |
| --- | ---: | ---: | ---: |
| Traverse module graph by dependencies | 0.117 | 0.153 | +30.57% |
| Traverse module graph by connections | 0.026 | 0.029 | +11.58% |
| Traverse compilation.modules | 0.004 | 0.004 | +5.56% |
| stats.toJson() | 4.453 | 4.659 | +4.62% |
| collect imported identifiers | 0.016 | 0.018 | +15.92% |
| record module | 0.081 | 0.083 | +2.97% |
| is css mod | 0.005 | 0.005 | +0.00% |
| record chunk group | 0.003 | 0.003 | +10.71% |
| external getResolve | 0.202 | 0.211 | +4.45% |

**Read.** Three reference data points now exist for this binding:

| Mode | Size | Median runtime | Notes |
| --- | ---: | ---: | --- |
| baseline (`opt-level = 3`) | 50.55 MiB | — | every crate at speed |
| `patch-cargo-fns` (8 crates `=z`, 18 hot fns `=speed`) | 49.17 MiB (−2.73%) | −1.53% | minimal size win, slightly faster |
| `aggressive-z-95` (workspace `=z`, 18 hot **crates** `=3`) | 38.09 MiB (−24.65%) | +5.56% | crate-level pin-back |
| **`workspace-z-fns-speed`** (workspace `=z`, 18 hot **fns** `=speed`) | **35.12 MiB (−30.53%)** | **+5.56%** | **largest size win** |

If shipping size matters more than the worst-case bench, the combined
mode is the right knob. The runtime regression is concentrated in
`Traverse module graph by dependencies` — adding it (or the rspack
crates that contain its top symbols) to a future PGO profile would let
the hot-fn marker set lift it back to speed codegen too.

Bench JSON files committed:
- `perf_profiles/bench-fab9a720577bc4b90909dcfae1d534bdbe064aec-baseline-v3.json`
- `perf_profiles/bench-fab9a720577bc4b90909dcfae1d534bdbe064aec-workspace-z-fns-speed.json`

### What this composes with

`pgo-run.ts patch` writes only the `[patch.crates-io]` section. The
existing `pgo-run.ts apply` writes the workspace `opt-level` knob and
(unless `--no-package-overrides` is passed) the
`[profile.release.package.X]` overrides — they don't conflict (Cargo
applies both). Three sensible compositions:

1. **`apply --aggressive-size`** alone → workspace `=z`, hot crates
   pinned to `=3`. Best when you don't want to vendor anything;
   coarsest knob.
2. **`patch --apply`** alone → 8 patched crates default to `=z` with
   per-fn `=speed`, workspace stays at `=3`. Smallest tooling
   footprint; smallest size win.
3. **`apply --workspace-default z --no-package-overrides`** + **`patch
   --apply`** → workspace `=z` everywhere (long tail), 18 hot fns at
   `=speed` (hot path). Biggest size win.

Mode 3 is what the empirical bench above measures.

### Caveats (kept honest)

- **Nightly only.** `optimize_attribute` is a feature gate. The release
  build already pins `nightly-2026-04-16`; on stable, `cargo check` will
  fail loudly with the well-known feature-gate error.
- **Vendor cost.** `cargo vendor` materialises a few hundred MB of
  third-party source under `vendor/`. The patched dir is not committed to
  the repo; it's regenerated on demand.
- **Symbol-name → fn-name matching.** The rewriter strips a demangled
  symbol down to its leaf identifier (e.g.
  `<Pure as VisitMut>::visit_mut_expr` → `visit_mut_expr`) and matches
  `fn <name>(` in the source. Two fns sharing a name in different `impl`
  blocks both receive the marker; this is benign for size/speed
  decisions because they were both in the hot bucket of the *same crate*.
- **Macro-generated fns.** Anything emitted by a `macro_rules!` invocation
  doesn't appear as a `fn name(` token in source and is therefore skipped
  silently. The crate-level fallback (`apply --aggressive-size`) still
  covers it.

## Stronger optimizations than `opt-level = 3`

`rustc` itself caps `opt-level` at 3 — there is no "O4". The levers
above 3 live in three places: **LLVM flags via `-Cllvm-args`**,
**target-CPU/ISA selection**, and **post-link / source-attribute
optimizations**. The honest survey:

### LLVM flags via `-Cllvm-args=…`

`rustc` drives LLVM, so any LLVM `-mllvm` flag can be threaded in. The
ones that matter for size-vs-speed at fixed `opt-level=3`:

| Flag | What it does | Default at O3 | Effect |
| --- | --- | ---: | --- |
| `-Cllvm-args=-inline-threshold=N` | Per-callsite inline cost cap | `225` | Bumping to `1000`–`5000` enables much more aggressive inlining. Costs binary size; usually wins on tight call-heavy hot loops. |
| `-Cllvm-args=-unroll-threshold=N` | Loop-unrolling cost cap | `~150` | `300`–`1000` unrolls more loops. Big wins on inner numeric loops; near-zero gain on visitor/dispatch loops. |
| `-Cllvm-args=-unroll-runtime` | Runtime (variable trip-count) unrolling | off | Enables unrolling loops whose trip count is only known at runtime. |
| `-Cllvm-args=-enable-loop-distribute` | Splits one loop into several | off | Lets later passes vectorize parts that the original loop blocked. |
| `-Cllvm-args=-enable-loop-versioning-licm` | LICM with runtime aliasing checks | off | More hoisting at the cost of a runtime guard. |

These can be combined with `RUSTFLAGS` per-crate via `cargo
--config 'profile.release.package.<crate>.rustflags=[…]'` — though
beware: per-package `rustflags` is unstable (nightly) at the time of
writing. The portable alternative is to set `RUSTFLAGS` globally for a
release build.

### Target-CPU / ISA

`-Ctarget-cpu=native` lets LLVM use the host's full ISA (AVX-512,
BMI2, …). Massive on numerical hot loops; **breaks portability**, so
unusable for the shipped npm package. For shipped builds the realistic
upper bound is `-Ctarget-cpu=x86-64-v3` (Haswell/AVX2-class), which
NAPI-RS and `napi-rs/cli` set on some platforms by default.

### Real Rust PGO (`-Cprofile-generate` / `-Cprofile-use`)

This is the **actual** PGO that the toolchain in this directory is
*not* — it instruments a build, runs it under a representative
workload, and rebuilds with branch/inline decisions guided by sample
data. Empirical wins on rustc itself are 10–20% throughput. Costs:

- Two-build pipeline (instrumented → profile → optimized).
- Profile data (`*.profraw`) must be merged with `llvm-profdata` and is
  toolchain-version-sensitive.
- Layered on top of fat-LTO it adds another 10–15 min to the release
  build.

Compatible with our crate-level `opt-level` overrides — they're
orthogonal. Can be added later as a separate stage.

### BOLT (post-link binary layout)

Facebook's BOLT reorders basic blocks and functions in the linked
binary based on sample profiles, independent of compilation. Reported
2–8% speedups on large native binaries (clang, MySQL). Works on
ELF/Mach-O. Two caveats for an `.npm`-shipped artifact:

- BOLT mutates the binary post-link → invalidates code signatures →
  notarization-blocking on macOS, Authenticode-stripping on Windows.
- The reordering is profile-shaped, so a workload mismatch can
  *regress* throughput.

Linux-only-shipped use is feasible if BOLT runs in CI right before
publish; macOS/Windows would need their own per-platform plan.

### Nightly-rustc levers

| Flag / attribute | Effect | Stable? |
| --- | --- | :---: |
| `-Z mir-opt-level=4` | Higher MIR-level optimization (default 2 at `opt-level=3`); may catch redundancies LLVM doesn't | nightly |
| `-Z share-generics=n` | Disables sharing of generic monomorphisations across CGUs → more specialized code (size up, speed up) | nightly |
| `#[optimize(speed)]` / `#[optimize(size)]` | Per-fn override of the active opt-level | nightly: rust-lang/rust#54882 |
| `#[inline(always)]` | Force inline regardless of LLVM's threshold | **stable** |
| `#[cold]` | Mark a fn as cold; LLVM treats its body as a low-priority size sink | **stable** |

`#[inline(always)]` + `#[cold]` together are the only **stable** way to
get function-level optimization decisions without nightly. The
function-level classifier (`pgo-run.ts classify-fns`) emits both lists
ready to drop into source.

### What this PR does *not* yet wire up

- LLVM flag passthrough (`-Cllvm-args=…`) — workspace `RUSTFLAGS` in
  `crates/node_binding/scripts/build.js` is the integration point; left
  out of the per-crate managed block because per-package `rustflags` is
  nightly-unstable.
- Real `-Cprofile-use` PGO — separate, larger pipeline change.
- BOLT — post-publish step for the Linux artifact only; needs its own
  CI hook and the symbolication-friendly unstripped build that
  `pgo-profile` already requires.

## Classifier algorithm

1. Sort crates by sample count, descending.
2. Walk the list accumulating each crate's `pct`, **normalized against the
   sum of attributable (non-`<unknown>`) crate shares** so a large kernel /
   libc / JIT bucket can't make the threshold unreachable. Every crate
   whose *previous* normalized cumulative share was below
   `hotCumulativeShare` (default `0.85`) is **hot**; the rest are **cold**.
3. `<unknown>` (kernel, libc, anything we couldn't attribute) is excluded.
4. `alwaysHot` / `alwaysCold` lists override the heuristic last — useful
   for pinning crates we know belong in one bucket regardless of what a
   single benchmark happened to stress.
5. `candidates` extends the result set with crates that didn't appear in
   the profile, defaulting them cold.

The threshold is intentionally generous (`0.85`, not `0.95`): we want a
small hot set, because every crate we leave in the hot bucket is one that
keeps the larger `opt-level=3` codegen, and binary-size wins come from
shrinking the cold-tail majority.

## What the apply step actually emits

Two-rule generator, designed to keep the diff small:

- The workspace `[profile.release].opt-level` is detected automatically.
- **Hot crates** are emitted only when the workspace default is *not* the
  hot opt-level (`3`). On the current `[profile.release].opt-level = 3`
  config, hot crates are no-ops and are intentionally omitted.
- **Cold crates** always emit `opt-level = "z"`.

So on today's repo state (workspace default = 3), `apply` produces a block
that is just the cold-tail overrides:

```toml
# >>> pgo-managed-overrides >>>
# Generated by .github/workflows/scripts/pgo-apply-overrides.ts.
# Do not edit by hand — re-run pgo-run.ts to refresh.
# Workspace [profile.release].opt-level detected as 3.

[profile.release.package.nu_ansi_term]
opt-level = "z"  # cold: 0.05% (below hot-share threshold)

[profile.release.package.owo_colors]
opt-level = "z"  # cold: 0.05% (below hot-share threshold)
# <<< pgo-managed-overrides <<<
```

If we ever flip the workspace default to `"s"` globally (a separate
decision tracked under `binary-size-experiment.yml`), the same `apply` run
would *also* emit hot-crate overrides at `opt-level = 3` — i.e. the
inverted shape, where hot crates earn back full vectorization on top of a
size-default workspace.

## Crate attribution

`crateFromSymbol` in `pgo-profile.ts` extracts the leading crate name from
demangled Rust symbols. Two common shapes:

```
rspack_core::module::Module::build
                                ↑ crate = "rspack_core"

<rspack_core::compilation::Compilation as rspack_core::Build>::do_build
 ↑ implementor crate = "rspack_core"
```

Trait-impl symbols are attributed to the **implementor** (the type whose
machine code actually runs), not the trait crate. Bracketed symbols
without a `<… as …>` clause are unwrapped and the leading crate is
extracted. Anything that doesn't match `[a-zA-Z_][a-zA-Z0-9_]*` (kernel
symbols, libc, anonymous vtable entries) is bucketed under `<unknown>`
and excluded from classification.

## Going deeper: function- and loop-level inspection

The crate-level classifier (`pgo-classify.ts`) decides per-crate
`opt-level` overrides — that's the loop the build pipeline drives. But
the same `perf_profiles/<sha>.json` carries the top-100 leaf symbols
(with attributed crate and sample count), so once you know *which*
crates are hot you can drill in to *which functions inside them* are
hot.

`pgo-report.ts` is the function-level companion. It takes a stored
profile and renders a Markdown report with:

- **Top hot functions across the whole binding** — ranked, with
  cumulative share. Answers "where would 1 hour of human optimization
  effort have the biggest impact?"
- **Hot functions inside each hot crate** — for every crate the
  classifier marked hot, its top functions in this profile, with both
  whole-binding share and within-crate share. Answers "we know
  `swc_ecma_minifier` is hot — *which* visitor is the expensive one?"
- A **per-function loop / instruction recipe** using `perf annotate`
  against the same `perf.data` the profile JSON came from.

```bash
# Render the function-level report from the committed profile:
node --experimental-strip-types \
  .github/workflows/scripts/pgo-run.ts report \
  --profile perf_profiles/<sha>.json \
  --top-global 25 --functions-per-crate 8

# Drop into per-instruction (and per-loop) view of one function:
perf annotate -i perf_profiles/<sha>.perf.data --stdio --source \
  swc_ecma_minifier::compress::pure::Pure

# Hot loops across the whole binding (sym + source-line aggregation):
perf report -i perf_profiles/<sha>.perf.data \
  --stdio --no-children -s sym,srcline | head -50
```

Loops typically show up in `perf annotate` as the basic block(s) with
the highest per-instruction sample density inside one of the hot
functions above. There is no nightly-stable Rust mechanism to apply
per-function `opt-level` from `Cargo.toml` (that's an attribute on the
function itself: nightly `#[optimize(speed)]` / `#[optimize(size)]`),
so the action this report suggests is one of:

1. Tighten the *crate* threshold so the surrounding crate gets `=3`.
2. Annotate the specific hot function with `#[inline]` /
   `#[inline(always)]` / `#[cold]` in source.
3. Restructure the hot loop in source (the usual response).

## Function-level classification (`classify-fns`)

`pgo-classify-functions.ts` is the function-level analogue of the
crate-level classifier: same cumulative-share algorithm, but operating
on the recorded `top_symbols` instead of `by_crate`. It tells you,
inside the hot crates, *which specific functions* are responsible for
the CPU. That answers "top speed where it matters, smallest code
everywhere else" at a finer granularity than Cargo can natively
consume.

```bash
# Apply across the whole top_symbols list (default threshold 0.50):
node --experimental-strip-types \
  .github/workflows/scripts/pgo-run.ts classify-fns \
  --profile perf_profiles/<sha>.json --threshold 0.50

# Drill into specific hot crates:
node --experimental-strip-types \
  .github/workflows/scripts/pgo-run.ts classify-fns \
  --profile perf_profiles/<sha>.json --threshold 0.50 \
  --restrict swc_ecma_minifier,swc_ecma_ast,swc_ecma_parser
```

### Why function-level is *advisory*, not auto-applied

Cargo profile overrides have package granularity: `[profile.release.package.X]`
exists, `[profile.release.package.X.function.Y]` does not. To act on
function-level decisions you have to add source-level attributes:

| Granularity | Cargo can apply it? | Stable Rust? | Notes |
| --- | :---: | :---: | --- |
| Per-crate `opt-level` | ✅ | ✅ | What `pgo-apply-overrides.ts` does. |
| Per-function `#[inline]` / `#[cold]` | ❌ source only | ✅ | Hint to LLVM. `#[cold]` shrinks code on the cold path; `#[inline(always)]` forces inlining. Doesn't change opt-level. |
| Per-function `#[optimize(speed)]` / `#[optimize(size)]` | ❌ source only | ❌ nightly | Real per-function opt-level. Requires `#![feature(optimize_attribute)]`. |

For our **own** crates (`rspack_*`) those source patches are local and
trivial. For **third-party** crates (swc, hashbrown, indexmap, hstr —
which dominate this profile) the only options are:

- Vendor the crate via `[patch.crates-io]` and apply attributes to the
  vendored copy. Maintenance cost: rebases on upstream releases.
- Upstream the annotation. Slow, but the hot symbols here (e.g. the
  visit\_mut\_expr family) are obvious, stable hot paths — a reasonable
  upstream PR target.

Practical recommendation given those constraints: keep using the
crate-level loop (`apply --threshold 0.95` already gives **−19.19%**
on the actually-shipped binding), use `classify-fns` to identify the
~20 functions that account for half of attributable CPU, and:

- For the ~2 hot symbols inside crates we own (e.g. `ScopeInfoDB::get`
  in `rspack_plugin_javascript`), if they are flagged *cold* (large
  helper inside an otherwise-hot crate), wrap with `#[cold]`. If
  flagged *hot*, leave them alone — they're already at `opt-level=3`.
- For third-party hot symbols, do nothing automatically. Use the list
  to guide manual investigation with `perf annotate <symbol>` for
  loop-level hotspots.

## Validation

`pgo-run.ts validate` is intentionally minimal: it just checks that the
expected `rspack.<platform>.node` artifact exists and is non-empty after
rebuild. The heavy lifting — confirming throughput hasn't regressed — is
deliberately the caller's job, since "did this make us faster?" is a
benchmark question and benchmarks vary by workload. A typical flow is:

```bash
# Snapshot baseline perf before pgo-run.
hyperfine --warmup 3 --runs 10 'node my-bench.js' > before.txt

# Apply pgo-managed overrides + rebuild.
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts all -- node my-bench.js

# Re-measure and diff.
hyperfine --warmup 3 --runs 10 'node my-bench.js' > after.txt
diff before.txt after.txt
```

## Testing

```bash
node --experimental-strip-types --test .github/workflows/scripts/pgo.test.ts
```

21 cases covering: symbol→crate attribution (normal symbols, trait-impl
symbols, kernel/unattributable), `perf script` parsing (LF + CRLF + empty
input + leaf-only counting), per-crate aggregation, profile JSON
round-trip + schema-version rejection, classifier (cumulative threshold
boundary, `<unknown>` exclusion, `alwaysHot`/`alwaysCold` overrides,
`candidates` fall-back, threshold range checks), managed-block render
(workspace-default-aware emission, idempotent re-application,
removal-leaves-manual-overrides-alone), and end-to-end file write +
no-op-on-rerun.

## Limitations / non-goals

- **Not Rust PGO.** This does not use `-Cprofile-generate` /
  `-Cprofile-use`. If you want true PGO for max throughput, see the
  upstream
  [Rustc Profile-Guided Optimization](https://doc.rust-lang.org/rustc/profile-guided-optimization.html)
  docs — that's a different, complementary tool.
- **Single platform per run.** `perf` is Linux-only; for macOS/Windows
  use `samply` or `Instruments` and convert to `perf script`-compatible
  output, or extend `pgo-profile.ts` with a per-platform runner.
- **One workload.** A single benchmark profile reflects only the crates
  that workload exercises. The driver does not automatically merge
  profiles from multiple workloads — generate per-workload JSON files
  and combine them by hand if you want a multi-bench view.
- **No automatic rollback on perf regression.** `validate` checks
  artifact existence only; you must benchmark separately.

## Empirical run on the actual binding

Profile: `perf_profiles/bb4b6f7e2acf423926145b94eb1bea19801ee4c9.json`
(18,558 samples, 96 attributable crates, ts-react fixture × 100, recorded
under `perf record -F 999 -g --call-graph dwarf`).

Classifier output at the default `--threshold 0.85` (after the `<unknown>`
normalization fix): **11 crates hot** (cumulative 67.84% of attributable
samples — `swc_ecma_minifier`, `swc_ecma_ast`, `swc_ecma_parser`,
`swc_ecma_transforms_base`, `hashbrown`, `swc_ecma_utils`,
`swc_ecma_compat_es2015`, `swc_ecma_transforms_optimization`,
`rspack_plugin_javascript`, `core`, `swc_ecma_codegen`),
**84 crates cold** (long tail dropped to `opt-level = "z"`).

Real `librspack_node.so` cdylib (Linux x86_64, full production release
profile: `lto="fat"`, `codegen-units=1`, `strip=true`, `panic="abort"`,
`-Zbuild-std=panic_abort,std`, `-Cforce-unwind-tables=no`,
`--features plugin,info-level`, toolchain `nightly-2026-04-16`):

| Variant | Bytes | MiB | % of baseline | Δ |
| --- | ---: | ---: | ---: | ---: |
| baseline (workspace `opt-level = 3`, no managed block) | 58,397,088 | 55.69 | 100.00% | — |
| **PGO-applied, `--threshold 0.85`** (11 hot, 84 cold at `"z"`) | 49,782,056 | 47.48 | 85.25% | −8,615,032 B (−8.21 MiB, −14.75%) |
| **PGO-applied, `--threshold 0.95`** (18 hot, 77 cold at `"z"`) ⭐ | **47,191,592** | **45.01** | **80.81%** | **−11,205,496 B (−10.69 MiB, −19.19%)** |
| `opt-level = "s"` global (no PGO, every dep) | 37,681,064 | 35.94 | 64.53% | −20,716,024 B (−35.47%) |
| `opt-level = "z"` global (no PGO, every dep) | 31,086,120 | 29.65 | 53.23% | −27,310,968 B (−46.77%) |

**Read:** at `--threshold 0.95` the PGO loop **simultaneously preserves
more hot crates *and* produces a smaller binary** than at `0.85`
(47.19 MiB vs 47.48 MiB, with 18 hot vs 11 hot). The mechanism is
cross-crate LTO: keeping more crates at `opt-level = 3` gives fat-LTO
a larger contiguous region to inline and dedupe across, which on this
workload outweighs the per-crate code-size growth from `=z` → `=3`.
The seven additional hot crates at the wider threshold —
`swc_ecma_codegen`, `hstr`, `swc_common`, `indexmap`, `swc_ecma_transformer`,
`swc_ecma_transforms_typescript`, `alloc` — would have been compiled at
`opt-level = "z"` at `0.85`; promoting them to `=3` lets fat-LTO merge
the call sites with the SWC visitor stack instead of treating them as
opaque size-optimized boundaries. The headline PGO result we report is
the `--threshold 0.95` build: **47,191,592 bytes, −19.19% vs baseline**,
while keeping ~92% of attributable CPU on `opt-level = 3` codegen.

`--threshold 0.85` recovers ~31% of the size savings of "global `"z"`"
(−14.75% vs −46.77%); `--threshold 0.95` recovers ~41% (−19.19% vs
−46.77%) while preserving more hot paths. The remaining gap to the
global-`z` build is the size contribution of the hot crates we
deliberately did *not* shrink, plus the parts of `<unknown>`
(kernel/libc/JIT, ~19% of samples) that aren't attributable to a Rust
crate at all.

The trade-off:

- **Global `"z"`** — biggest size win (−46.8%) but every dependency,
  including the SWC hot path, gets the smaller-but-slower codegen.
- **PGO-applied** — smaller size win (−14.8%) but the hot 67.84% of CPU
  time still runs at `opt-level = 3`. Expect roughly baseline throughput on
  workloads similar to the profiled benchmark (TS/React with SWC), and
  some throughput regression on workloads that hit the cold-tail crates
  (regex-heavy passes, hashing, etc.).

The numbers above are produced by running, in order, from a clean repo:

```bash
# baseline
RUSTFLAGS="-Cforce-unwind-tables=no" cargo +nightly-2026-04-16 build \
    --release -p rspack_node \
    --target x86_64-unknown-linux-gnu \
    -Zbuild-std=panic_abort,std \
    --no-default-features --features plugin,info-level
stat -c '%s' target/x86_64-unknown-linux-gnu/release/librspack_node.so
# → 58,397,088

# pgo-applied (--threshold 0.85, 11 hot)
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts apply \
    --profile perf_profiles/bb4b6f7e2acf423926145b94eb1bea19801ee4c9.json
RUSTFLAGS="-Cforce-unwind-tables=no" cargo +nightly-2026-04-16 build \
    --release -p rspack_node \
    --target x86_64-unknown-linux-gnu \
    -Zbuild-std=panic_abort,std \
    --no-default-features --features plugin,info-level
stat -c '%s' target/x86_64-unknown-linux-gnu/release/librspack_node.so
# → 49,782,056

# pgo-applied (--threshold 0.95, 18 hot — recommended)
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts apply \
    --profile perf_profiles/bb4b6f7e2acf423926145b94eb1bea19801ee4c9.json \
    --threshold 0.95
pnpm run build:binding:release
stat -c '%s' crates/node_binding/rspack.linux-x64-gnu.node
# → 47,191,592
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts revert
```

PR-state Cargo.toml has the managed block reverted, so a fresh
`pnpm run build:binding:release` reproduces the baseline number, not
the PGO-applied number; running `pgo-run.ts apply` against the committed
profile re-emits the same managed block we measured.


## Runtime benchmarks

Binary size is half the story; the size knobs (`opt-level = "s"` /
`"z"`, aggressive-size mode) trade some throughput for the bytes. To
measure that trade-off, the toolchain wraps the project's existing
`tests/bench/ts-react.bench.ts` (vitest) so per-variant runtime
numbers can be captured and diffed.

### Recipe

```bash
# 1) bench prep (clones rstackjs/rspack-benchcases, installs)
pnpm run bench:prepare

# 2) build the binding for whatever variant you want to measure;
#    each subsequent measure run uses whatever binding is installed.
pnpm run build:binding:release   # baseline = current Cargo.toml
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts \
    bench --label baseline

# 3) flip to aggressive-size, rebuild, re-bench
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts \
    apply --aggressive-size --threshold 0.95
pnpm run build:binding:release
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts \
    bench --label aggressive-z-95

# 4) restore Cargo.toml byte-for-byte
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts revert

# 5) compare the two stored runs
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts \
    bench-compare \
    perf_profiles/bench-<sha>-baseline.json \
    perf_profiles/bench-<sha>-aggressive-z-95.json
```

Each `bench` run writes `perf_profiles/bench-<git_sha>-<label>.json`
with this shape (see `pgo-bench.ts` for the schema):

```json
{
  "schemaVersion": 1,
  "gitSha": "…",
  "label": "aggressive-z-95",
  "timestamp": "…",
  "samples": [
    { "name": "ts-react.bench.ts > build",   "meanMs": 12.5, "hz": 80.0,  "stdDevMs": 0.4, "samples": 10 },
    { "name": "ts-react.bench.ts > rebuild", "meanMs": 5.25, "hz": 190.5, "stdDevMs": 0.12, "samples": 12 }
  ]
}
```

`bench-compare` produces a markdown table with `Δ%` per benchmark
(negative = candidate faster) plus an overall median delta. Median is
preferred over mean for the headline because vitest occasionally emits
a single high-variance sample on the first iteration of a cold start.

### Toolchain note (nightly is OK)

The release-build profile already pins
`channel = "nightly-2026-04-16"` (via `rust-toolchain.toml` /
`-Zbuild-std`), and the function-level levers `#[optimize(speed)]` /
`#[optimize(size)]` and `-Z mir-opt-level=4` / `-Z share-generics=n`
documented above are nightly-only — so for any runtime experiment that
turns those on, **stay on the same nightly the binding already uses**
to avoid mixing rlibs across toolchains. The bench wrapper itself
makes no toolchain assumption: it just runs whatever binding is in
`crates/node_binding/`.

### Empirical runtime bench: baseline vs aggressive-size

Real numbers from `pnpm run build:binding:release` on this branch
(toolchain `nightly-2026-04-16`, x86_64-unknown-linux-gnu, full
production release profile incl. fat-LTO + `-Zbuild-std`), vitest
3.2.4 benchmarks from `tests/bench/ts-react.bench.ts`. The
`aggressive-z-95` build was produced by:

```bash
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts \
    apply --aggressive-size --threshold 0.95 \
    --profile perf_profiles/bb4b6f7e2acf423926145b94eb1bea19801ee4c9.json
pnpm run build:binding:release
```

i.e. workspace `[profile.release].opt-level = "z"` with 18 hot crates
(incl. third-party `swc_ecma_*`, `hashbrown`, `hstr`, `swc_common`,
`indexmap`, `regex_automata`, `alloc`) overridden back up to `=3`.
The Cargo.toml managed block is then `revert`-ed in the PR — the
committed bench JSONs reproduce these numbers when the same `apply`
is re-run.

**Binary size** (the shipped `rspack.linux-x64-gnu.node`):

| Variant | Bytes | MiB | Δ vs baseline |
| --- | ---: | ---: | ---: |
| baseline (workspace `opt-level = 3`) | 53,007,144 | 50.55 | — |
| **aggressive-z-95** | **39,943,592** | **38.09** | **−13,063,552 B (−24.65%)** |

Build time: baseline 16m 15s, aggressive-z-95 13m 14s (faster, same
mechanism as the global-`s`/`z` measurements: opt-for-size skips the
expensive vectorization passes).

**Runtime** (`tests/bench/ts-react.bench.ts`, 9 vitest benchmarks
exercising the JS API surface against the React fixture; mean ms per
iter, lower is faster):

| Benchmark | Baseline mean (ms) | aggressive-z-95 mean (ms) | Δ |
| --- | ---: | ---: | ---: |
| js@Traverse module graph by dependencies | 0.145 | 0.141 | **−3.23%** |
| js@Traverse module graph by connections | 0.026 | 0.029 | +8.33% |
| js@Traverse compilation.modules | 0.004 | 0.004 | +5.56% |
| js@stats.toJson() | 4.386 | 4.490 | +2.37% |
| js@collect imported identifiers | 0.016 | 0.018 | +17.09% |
| js@record module | 0.083 | 0.083 | −0.84% |
| js@is css mod | 0.005 | 0.005 | +0.00% |
| js@record chunk group | 0.003 | 0.003 | +10.71% |
| js@external getResolve | 0.209 | 0.227 | +8.36% |

**Overall: median Δ = +5.56%, mean Δ = +5.37%** (positive = candidate
slower; negative = candidate faster). vitest's per-iter `rme`
(relative margin of error) on these runs is mostly 0.3%–2%, with
`external getResolve` showing 7%–13% variance — most of the
single-bench Δs above are above the within-run noise floor, but
`record module`, `is css mod`, and `Traverse compilation.modules` are
inside it.

**Read:** the aggressive-z-95 variant trades **~5.5% runtime** for
**−24.65% binary size** (−12.5 MiB) on this workload, *with the SWC
hot path preserved at `opt-level = 3`*. The 17% regression on
`collect imported identifiers` is the largest single-bench cost and
likely points to a cold-tail crate the 0.95 classifier didn't
promote — re-running `pgo-profile.ts` against the bench harness
itself (instead of the legacy committed profile) would shorten that
gap. The size win is real and the throughput cost is small; whether
to ship is a product judgment, not a measurement question.

### Diagnosing and mitigating the bench regressions

The committed profile (`bb4b6f7e…json`) was recorded against an
SWC-minification-heavy build, which dominates the call graph. As a
result, crates that the JS-side bench harness exercises heavily —
but that don't appear in the minifier's call graph — get classified
**cold** and dropped to `opt-level = "z"`. Concretely from the
profile:

| Crate exercised by regressed benches | Profile share | 0.95 classification |
| --- | ---: | --- |
| `rspack_core` (ModuleGraph / ChunkGraph / Stats / NormalModule) | 0.44% | cold |
| `rspack_napi` (NAPI bridge for every JS getter) | (below sample threshold) | cold |
| `rspack_resolver` (used by `external getResolve`) | 0.10% | cold |
| `rspack_loader_runner`, `rspack_collections`, `rspack_paths`, `rspack_fs` | ≤ 0.03% each | cold |

The seven regressed benches all hit one or more of the above. So the
mitigation without re-profiling is to force-promote them to hot via
the new `--always-hot` flag on `pgo-run.ts apply`:

```bash
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts \
    apply --aggressive-size --threshold 0.95 \
    --always-hot rspack_core,rspack_napi,rspack_resolver,rspack_loader_runner,rspack_collections,rspack_paths,rspack_fs \
    --profile perf_profiles/bb4b6f7e2acf423926145b94eb1bea19801ee4c9.json
```

This keeps the workspace default at `opt-level = "z"` (so the
minifier and other long-tail crates still shrink) but pins the
graph-traversal / NAPI-bridge crates back to `opt-level = 3`, which
is what those bench paths actually need.

The cleaner fix is to re-record the profile against a workload that
includes the bench harness itself (or any other JS-API-heavy
workload) so the classifier picks these crates up automatically:

```bash
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts \
    profile -- pnpm --filter "@rspack/test-tools" run bench
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts \
    apply --aggressive-size --threshold 0.95
```

`--always-hot` is the surgical override; re-profiling is the
correct general answer.


### Workspace-crate per-fn `=speed` markers (workspace mode)

The cargo-patch path (per-fn `#[optimize(speed)]` / `=size`) was
originally wired only for **third-party** crates: it edits a
vendored copy under `vendor/<crate>/` and adds a
`[patch.crates-io]` redirection so cargo picks up the rewritten
source. Workspace crates (`rspack_core`, `rspack_plugin_javascript`,
…) live at `crates/<name>/` already, so they need a different
strategy: there is no `[patch.crates-io]` indirection — we just
edit them in place under sentinel-managed comments and revert
byte-identically afterwards.

`buildPatchPlan(profile, { repoRoot, … })` (and the wrapper
`pgo-run.ts patch …`, which now passes `repoRoot` automatically)
classifies any crate whose `<repoRoot>/crates/<name>/Cargo.toml`
exists as `kind: "workspace"`. For those:

- No `[patch.crates-io]` entry is emitted.
- No `[profile.release.package.<crate>] opt-level = "z"` is
  emitted — the workspace knob set by
  `apply --workspace-default z` covers it.
- `patch --apply` walks `crates/<name>/src/**.rs` directly,
  injects `#![feature(optimize_attribute)]` at `lib.rs` and
  `#[optimize(speed)] // pgo-managed` on each hot fn.
- `patch-revert` walks every `crates/*/` and strips the markers
  (and the lib header) byte-identically. Idempotent — clean repos
  see zero changes.

Worked example against the committed minifier-shaped profile,
threshold 0.99 (exposes the lower-pct workspace symbols that a
0.50-threshold patch misses):

```bash
$ node --experimental-strip-types .github/workflows/scripts/pgo-run.ts \
    patch --profile perf_profiles/bb4b6f7e2acf423926145b94eb1bea19801ee4c9.json \
          --threshold 0.99 --apply
plan: 14 crate(s) (13 third-party + 1 workspace), 75 hot fn(s), 0 cold fn(s)
…
[workspace] rspack_plugin_javascript: 5 edit(s) across 4 file(s)
```

Five edits land in `crates/rspack_plugin_javascript/`:
`#![feature(optimize_attribute)]` in `lib.rs` plus
`#[optimize(speed)]` on `JavascriptParser::evaluate_expression`,
`ScopeInfoDB::get`, and the two other `get` impls in that crate
that share the same fn-name regex.

Clean revert:

```bash
$ node --experimental-strip-types .github/workflows/scripts/pgo-run.ts patch-revert
[pgo-run] ▶ patch revert
  removed managed [patch.crates-io] block
  reverted [workspace] rspack_plugin_javascript: 5 edit(s) across 4 file(s)

$ git diff crates/  # ← empty
```

### Profile capture caveat: stripped binding ≠ attributable samples

`pgo-run.ts profile -- <bench cmd>` runs `perf record -F 999 -g
--call-graph dwarf` by default. Two practical issues to know
about when re-recording on top of the shipped release-profile
binding:

1. **Symbols are stripped** in the production build
   (`crates/node_binding/scripts/build.js` sets `strip=true`),
   so `perf script` reports every binding sample as
   `[unknown] (rspack.linux-x64-gnu.node)` and the JSON ends up
   with `0 samples, 0 crates`. To re-record a bench-shaped
   profile, build with the **profiling** profile
   (`pnpm run build:binding:profiling`) or temporarily flip
   `strip=false` for the variant you're measuring; the call
   graph won't change vs. release because LTO/cgu are the same.

2. **`--call-graph dwarf` post-processing is O(n²) on big
   `.node` files.** With ~50 MiB of stripped cdylib and 700+
   samples, `addr2line` (invoked by perf at exit to resolve
   inline frames) can run for **15+ minutes**. The PGO loop only
   reads leaf-symbol samples from `perf script -F
   …,event,ip,sym,dso` — it never consumes call chains — so set
   `PGO_CALL_GRAPH=none` (or `fp` for cheap frame-pointer
   chains) when running the profiler purely for crate/fn
   attribution:

   ```bash
   PGO_CALL_GRAPH=none node --experimental-strip-types \
     .github/workflows/scripts/pgo-run.ts profile -- pnpm -C tests/bench bench
   ```

   The default stays `dwarf` for back-compat with interactive
   perf users who want full callchains for `perf report` /
   `perf annotate` (used by `pgo-run.ts report`).

3. **One-shot wrapper.** `pgo-run.ts profile-bench` codifies the
   recipe: it runs `pnpm run build:binding:profiling` (so debug
   info + unwind tables stay in the cdylib) and then perf-records
   the project's vitest bench harness against it, writing the
   resulting `perf_profiles/<sha>.json`. Pass `--skip-build` if a
   profiling binding already exists. Combine with
   `PGO_CALL_GRAPH=none` for the fast attribution-only path:

   ```bash
   PGO_CALL_GRAPH=none node --experimental-strip-types \
     .github/workflows/scripts/pgo-run.ts profile-bench
   # then, against the bench-shaped profile this just produced:
   node --experimental-strip-types .github/workflows/scripts/pgo-run.ts \
       apply --workspace-default z --no-package-overrides
   node --experimental-strip-types .github/workflows/scripts/pgo-run.ts \
       patch --threshold 0.95 --apply
   ```

   The `apply --no-package-overrides` step keeps the workspace
   `=z` shrinkage but avoids pinning hot crates back to `=3`; the
   `patch --threshold 0.95 --apply` step then injects per-fn
   `#[optimize(speed)]` markers on the rspack workspace fns the
   *bench* profile actually exercises (graph traversal, stats,
   napi bridge, …) — so the regressed bench cases get speed
   codegen on their hot paths without giving up the size win.

### Empirical run on the actual binding (bench-shaped workspace per-fn `=speed`)

This is the run produced by the recipe in the previous section,
recorded against the project's vitest bench harness
(`tests/bench/ts-react.bench.ts`) so the hot-fn set is the one
the benches actually exercise — `rspack_core`'s `ModuleGraph` /
`ChunkGraph` / `Stats` paths and the `rspack_binding_api` NAPI
bridge — instead of the SWC-minifier shape the legacy
`bb4b6f7e…json` profile inherited.

Setup (this repo, x86\_64-linux,
nightly-2026-04-16, full release flags
`lto="fat" cgu=1 strip=true panic="abort" -Zbuild-std
-Cforce-unwind-tables=no --features plugin,info-level`):

| Variant | `.node` bytes | MiB | Δ size | Median runtime Δ |
| --- | ---: | ---: | ---: | ---: |
| baseline-v3 (`opt-level = 3`) | 53,007,144 | 50.55 | — | — |
| **workspace-z-fns-speed-bench-shaped** | **36,813,736** | **35.11** | **−30.55%** | **+11.11%** (mean +13.17%) |

The bench-shaped profile classifier surfaced **2 workspace
crates** at `--threshold 0.95`: `rspack_binding_api` (7 fns
marked) and `rspack_core` (31 fns marked across 19 files). Top
hot leaves are `<JsCompilation>::modules` (0.98%),
`<ModuleGraphConnection>::module` (0.25%), and
`OverlayMap::get` (0.28%) — exactly the path the regressed
benches go through. The 2 third-party crates the classifier
also surfaced (`napi`, rust stdlib `core`) have no
`vendor/<name>` directory in this checkout, so
`buildPatchPlan` automatically excludes them from the
`[patch.crates-io]` block (see "Vendor availability" below) —
without that fix `cargo metadata` fails outright with
`failed to read vendor/core/Cargo.toml`.

Per-benchmark deltas vs `baseline-v3` (negative = candidate
faster):

| Benchmark | Baseline (ms) | Candidate (ms) | Δ |
| --- | ---: | ---: | ---: |
| Traverse module graph by dependencies | 0.117 | 0.161 | +37.75% |
| Traverse module graph by connections | 0.026 | 0.029 | +13.13% |
| Traverse compilation.modules | 0.004 | 0.004 | +11.11% |
| stats.toJson() | 4.453 | 4.581 | +2.87% |
| collect imported identifiers | 0.016 | 0.018 | +14.65% |
| record module | 0.081 | 0.085 | +5.58% |
| is css mod | 0.005 | 0.005 | +3.77% |
| record chunk group | 0.003 | 0.003 | +7.14% |
| external getResolve | 0.202 | 0.248 | +22.55% |

Bench JSONs:

- `perf_profiles/bench-fab9a720577bc4b90909dcfae1d534bdbe064aec-baseline-v3.json`
- `perf_profiles/bench-734eaddbfec27261e0e68b9afbddb763b9708aed-workspace-z-fns-speed-bench-shaped.json`

PGO profile (the one the recipe consumed):

- `perf_profiles/6341b53a046ad6c1f3cd09a7dbf22bfa1af9eae6.json`
  (10246 samples, 49 crates, recorded against the bench
  harness with the profiling binding so symbols resolve)

**Honest read.** The size win matches the
minifier-shaped run (−30.55% vs −30.53%) — the workspace `=z`
default is what does most of the lifting and that's identical
between the two profiles. The runtime cost on the
graph-traversal benches is *higher* than the minifier-shaped
run (+11.11% median vs +5.56%) because at `--threshold 0.95`
the bench-shaped profile is dominated by *non-Rust* leaves
(v8 GC, serde\_json escape, NAPI shim) — only ~2.5% of
attributable CPU lands in workspace Rust fns we can mark, and
the long tail of `rspack_core` graph helpers (each <0.1%)
stays at `=z`. To recover those, the next iteration needs
either (a) a much lower `--threshold` so the per-fn set
covers the long tail, or (b) `cargo vendor` so the third-party
hot crates (`napi`, `serde_json`, `hashbrown`) actually get
their per-fn `=speed` markers — both are now unblocked by the
tooling in this PR.

### Vendor availability: `[patch.crates-io]` only emits redirections that exist

`buildPatchPlan` checks `<repoRoot>/<vendor_root>/<name>/Cargo.toml`
existence for every third-party crate it would otherwise add to
the managed `[patch.crates-io]` block. If the file isn't there
(typical when `cargo vendor` hasn't been run), the crate is
dropped from the plan entirely — no `[patch.crates-io] X = {
path = "vendor/X" }` line, no `[profile.release.package.X]`
override, and no source-rewrite walk. This avoids breaking
`cargo metadata` with `failed to read .../vendor/X/Cargo.toml`
on workstations that haven't run `cargo vendor` yet. Tests can
inject a mock via `BuildPatchPlanOptions.isVendorAvailable`;
when `repoRoot` is unset the default is "always available", so
legacy unit-test plans built in isolation are unchanged.

### Selective vendoring: `pgo-run.ts vendor` (no full `cargo vendor` of the dep tree)

Running plain `cargo vendor` materialises the **full transitive
dep tree** (~1000+ crates, ~1 GiB on disk) into `vendor/`, which
is overkill when the patch plan only wants `#[optimize(speed)]`
markers in a small handful of hot third-party crates (e.g.
`napi`, `serde_json`, `hashbrown`). `pgo-run.ts vendor`
materialises **only** those crates by downloading their
crates.io tarballs directly:

```bash
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts \
    vendor --profile perf_profiles/<sha>.json --threshold 0.95
```

For each third-party crate in the patch plan it:

1. Resolves the version from `Cargo.lock` (the same lockfile
   `cargo build` consumes; see `parseLockfileVersion`).
2. Downloads the registry tarball from
   `https://crates.io/api/v1/crates/<name>/<version>/download`
   (follows redirects, no extra dependency).
3. Extracts to `vendor/<name>/` with `tar -xzf
   --strip-components=1`.

Workspace crates are skipped (they already live at
`crates/<name>/`). Crates whose version cannot be uniquely
resolved from `Cargo.lock` (multiple semver-incompatible
versions in the dep graph) are skipped with a structured
reason — surfacing instead of guessing. Re-running is
idempotent: if `vendor/<crate>/Cargo.toml` already exists the
download is skipped. Pass `--force` to re-extract.

The output is byte-identical to what `cargo vendor` would
produce for those crates (they're the same crates.io
tarballs), so the same `[patch.crates-io] X = { path =
"vendor/X" }` redirection that `pgo-run.ts patch` emits resolves
correctly. The crate's transitive deps continue to flow through
the normal registry index — that's the entire point of cargo's
patch mechanism: it replaces a single node in the dep graph
without forcing you to vendor the rest.

#### Recipe: bench-shaped profile + selective vendor + per-fn `=speed` markers

```bash
# 1) Capture a bench-shaped profile (debug-info preserved by build:binding:profiling).
PGO_CALL_GRAPH=fp node --experimental-strip-types \
    .github/workflows/scripts/pgo-run.ts profile-bench

# 2) Selectively vendor the hot third-party crates the profile flags.
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts \
    vendor --threshold 0.95

# 3) Apply the workspace-default = "z" knob (no per-package overrides;
#    per-fn markers handle the speed exceptions).
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts \
    apply --workspace-default z --no-package-overrides

# 4) Inject [patch.crates-io] + per-fn #[optimize(speed)] markers.
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts \
    patch --threshold 0.95 --apply

# 5) Rebuild + bench.
pnpm run build:binding:release
node --experimental-strip-types .github/workflows/scripts/pgo-run.ts \
    bench --label workspace-z-fns-speed-vendored
```

To revert: `pgo-run.ts patch-revert` + `pgo-run.ts revert`. The
`vendor/` tree can be deleted manually (it's gitignored). The
revert is byte-identical for `Cargo.toml` and every patched
workspace `crates/<name>/src/**.rs` file.

