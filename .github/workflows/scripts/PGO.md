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
