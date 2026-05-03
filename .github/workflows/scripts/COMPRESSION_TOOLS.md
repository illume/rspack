# Binary-size compression tools survey

**Scope:** Reduce the on-disk size of the shipped Rspack NAPI artifact —
`crates/node_binding/rspack.<platform>.node` — beyond what the existing
release configuration (`lto="fat"`, `codegen-units=1`, `strip=true`,
`panic="abort"`, `-Zbuild-std=panic_abort,std`, `-Cforce-unwind-tables=no`,
plus ~35 deps pinned at `opt-level="s"`) already produces.

**Audience:** Future maintainer evaluating whether to add a post-link
compression pass to the release build.

> **Format note.** The shipped artifact is a NAPI cdylib loaded by Node via
> `process.dlopen` (which calls `dlopen` on Linux/macOS, `LoadLibraryExW`
> on Windows). It is **not** a standalone executable. This rules out any
> tool that targets only `ET_EXEC` ELF, `MH_EXECUTE` Mach-O, or PE
> executables. What the loader sees is `ET_DYN` ELF, `MH_BUNDLE`/`MH_DYLIB`
> Mach-O, and PE DLL.

---

## What the existing release config already does

Currently shipped (verified in
[`crates/node_binding/scripts/build.js`](../../../crates/node_binding/scripts/build.js)
and [`Cargo.toml`](../../../Cargo.toml)):

| Knob | Value | What it saves |
| --- | --- | --- |
| `[profile.release].lto` | `"fat"` | Cross-crate inlining + dead-code elimination. Largest single contribution. |
| `[profile.release].codegen-units` | `1` | Lets LTO see every function. |
| `[profile.release].strip` | `true` | Removes symbol table + debug sections. |
| `[profile.release].panic` | `"abort"` | Drops landing pads + unwind tables. |
| `-Zbuild-std=panic_abort,std` | (cargo arg) | Rebuilds `std`/`alloc`/`core` against rspack's profile, drops unused std code. |
| `-Cforce-unwind-tables=no` | (rustflag) | Belt-and-braces with `panic="abort"`. |
| `info-level` feature | enabled | Drops `tracing` debug/trace level codegen. |
| ~35 deps at `opt-level="s"` | per-package | Diagnostic / TTY / utility crates compiled for size. |

The
[`binary-size-experiment.yml`](../binary-size-experiment.yml) workflow in
this directory runs reverse-tests (`no-build-std`, `no-info-level`) and
forward-tests (`opt-level-s-global`, `opt-level-z-global`, `lto-thin`,
`lto-off`) so a maintainer can quantify each knob's actual contribution
on real CI hardware.

The PR that landed this report also added `nu-ansi-term`, `owo-colors`,
`terminal_size` to the per-package `opt-level="s"` list — these are
diagnostic/TTY-only crates pulled in by `tracing-subscriber` / `miette`
and were not previously pinned.

---

## Compression tool survey, per platform

The matrix below records what is **actually possible**, what's
**recommended**, and what's a **dead-end** for this specific artifact
shape. "Verified" entries mean I empirically loaded a compressed shared
object via `dlopen`/`process.dlopen` and observed the result. Other
entries cite documentation and known issues.

### Legend

- ✅ **Loads** — the compressed artifact loads successfully.
- ⚠️ **Loads with caveats** — works mechanically but breaks signing,
  triggers antivirus, regresses startup, etc.
- ❌ **Does not load / not supported** — the tool either refuses the
  artifact format or produces a broken module.

### Linux x86_64-gnu / aarch64-gnu (`*.linux-*-gnu.node`, ELF `ET_DYN`)

| Tool | Result | Notes |
| --- | --- | --- |
| **UPX `--lzma`** | ⚠️ Loads (verified) | UPX 4.2.2 packs ELF shared objects with the `linux/amd64` and `linux/arm64` formats. Required: file must have `+x` bit (UPX refuses non-executable input). Dlopen test on a UPX-packed `libz.so.1` succeeded with `process.dlopen` ("Module did not self-register" = load OK, just not a NAPI module). **Caveats:** ~50–100 ms decompression at first load; defeats demand-paging so every Node process loading the addon gets a private RAM copy of the decompressed code instead of sharing it with other processes (multi-worker setups pay multiple times); breaks `gdb`/`perf` symbol resolution; triggers some endpoint AV. |
| `objcopy --compress-debug-sections=zstd` | n/a here | Targets only `.debug_*` sections, which `strip=true` already removes. Zero benefit on already-stripped artifacts. |
| `sstrip` (ELFkickers) | ✅ Loads | Strips ELF section headers entirely (kernel only needs program headers to load). Saves ~few KB on a stripped binary; tiny win. Some tooling (`file`, older `gdb`) misreads the result. |
| `lld --compress-relocations` | ✅ Loads | Linker-side, requires lld and rebuilding. Saves ≪ 1% on a release build. |
| `eu-strip --reloc-debug-sections` | ✅ Loads | elfutils variant of strip. No additional benefit beyond `strip=true`. |
| `Zstandard` filesystem compression (btrfs/zstd) | ✅ Loads (transparent) | Not a packaging-layer tool — only helps disk usage on the user's machine. Doesn't shrink the npm tarball or the on-disk file `du -b` size. |

#### Empirical UPX run on the actually-shipped `rspack.linux-x64-gnu.node`

Source: `npm pack @rspack/binding-linux-x64-gnu@2.0.1` (the artifact users actually
download), then `chmod +x` (UPX requires the executable bit) and pack with each
`upx` level. Run on `Linux x86_64`, UPX 4.2.2.

| Variant | Bytes | % of baseline | Δ vs baseline | Pack wall-time |
| --- | ---: | ---: | ---: | ---: |
| **baseline (shipped, already `strip=true` + LTO fat)** | **51,166,344** | 100.00% | — | — |
| `upx -1` (fastest)         | 24,998,764 | 48.86% | −26,167,580 (−51.14%) | ~2 s |
| `upx -9`                   | 20,267,884 | 39.61% | −30,898,460 (−60.39%) | ~25 s |
| `upx --best`               | 19,161,964 | 37.45% | −32,004,380 (−62.55%) | ~14 min |
| `upx --best --lzma` ⭐ best | **15,537,004** | **30.37%** | **−35,629,340 (−69.63%)** | ~30 s |

Headline: the best realistic UPX setting (`--best --lzma`) takes the on-disk
binding from **~48.8 MiB → ~14.8 MiB**, a **−69.6%** reduction (35.6 MB saved).
The `.tgz` users actually download will compress less than that delta (UPX
output is already high-entropy, so npm's gzip layer adds little on top — the
saving on the packed tarball is closer to the on-disk delta than to the gzip
ratio of the original).

This is the realistic ceiling for "compress the shipped Linux artifact" on a
release build that already has `strip=true`, `lto="fat"`, `codegen-units=1`,
`panic="abort"`, `-Zbuild-std`, `-Cforce-unwind-tables=no`, and ~38 deps at
`opt-level="s"` applied. The compiler/linker knobs cannot reach that
compression ratio — it comes from LZMA-compressing the entire `.text` and
`.rodata`, not from generating less code.

The recommendation in the [Recommendation](#recommendation) section below is
still **"do not ship UPX-packed bindings"**, but for the operational reasons
documented there (demand-paging, first-load latency, AV-flagging risk, broken
`addr2line`/`perf` symbolication for crash reports), not because the size
savings are unattractive. They aren't — they're the largest single lever
available on Linux.

### macOS arm64 / x86_64 (`*.darwin-*.node`, Mach-O `MH_BUNDLE`)

| Tool | Result | Notes |
| --- | --- | --- |
| **UPX** | ❌ Does not load | UPX's `macho/arm64` and `macho/amd64` formats target `MH_EXECUTE` only. NAPI artifacts on macOS are produced as `MH_BUNDLE` (Node's loader uses `dlopen` with `RTLD_LAZY`). UPX rejects bundles with `CantPackException: unsupported Mach-O format`. |
| **`strip -x`** | ✅ Loads | Already roughly equivalent to `strip=true` in `[profile.release]`. Negligible incremental win. |
| `lld -dead_strip` | ✅ Loads | LTO already does this; no extra benefit. |
| **Codesigning + notarization** | ❌ Blocker for any compressor | Any post-link mutation of the binary invalidates Apple's `LC_CODE_SIGNATURE` and the Apple Developer ID notarization ticket. Re-signing is possible but requires the maintainer's signing identity in CI. Notarization also rejects executables that mutate themselves at runtime (which packers do), so a notarized UPX-packed dylib is not realistically achievable. |

**Practical recommendation for macOS:** there is no compression tool I
would recommend here. Stick to compiler/linker knobs.

### Windows x64 / arm64 (`*.win32-*-msvc.node`, PE DLL)

| Tool | Result | Notes |
| --- | --- | --- |
| **UPX** | ⚠️ Loads with caveats | UPX 4.2.2's `win64/pe` and `win32/pe` formats handle DLLs (use `--force` if needed). The packed DLL loads via `LoadLibraryExW`. **Caveats:** Microsoft Defender's "Wacatac"/"Bulz" generic-packer signatures flag UPX-packed PE files at install time; corporate EDR products (CrowdStrike, SentinelOne, etc.) commonly quarantine them. Authenticode signatures placed before packing are stripped; signing after packing is possible but most signing pipelines (Azure SignTool, GitHub `code-signing` actions) sign before any post-link step. **Hard pass for an `npm install`-able package.** |
| **MPRESS** | ❌ Abandoned | Last release 2014, no maintenance, also AV-flagged. Don't use. |
| **Petite** | ❌ EXE only | Does not handle DLLs. |
| **Enigma Virtual Box / Themida / VMProtect** | ❌ Wrong tool | These are anti-tamper / DRM packers, not size compressors. They make binaries larger, not smaller. |
| **`mt.exe` / manifest stripping** | ✅ Loads | Removes embedded manifest if `link.exe` produced one. Cargo/MSVC release builds typically don't embed a meaningful manifest in cdylibs, so usually a no-op. |
| **Compressed CAB / zstd in installer** | ✅ Loads (transparent) | If the `npm install` flow ever moved to a self-extracting installer it could re-compress at the package layer. Out of scope for an `npm` distribution. |
| **NTFS file compression** | ✅ Loads (transparent) | User-side only; doesn't reduce tarball size. |

---

## Cross-cutting reasons compression rarely pays off for `.node` addons

1. **Demand-paging is already a form of compression.** Modern OSes only
   page in code that's actually executed. UPX-style decompression
   eagerly materializes the entire `.text` segment in private RAM,
   which can be a *net regression* in multi-process Node deployments.
2. **The npm tarball is already gzip-compressed.** Most "binary size"
   measurements that matter to users are install-time bandwidth, which
   sees only marginal additional benefit from compressing already-LTOed,
   already-stripped code (entropy is high; UPX/LZMA add ~20–35% on top
   of gzip on these inputs in our spot-check).
3. **Crash report quality matters.** Once an artifact is packed,
   `addr2line`-based stack symbolication from sentry/oncall reports no
   longer works, and `perf`/`Instruments`/ETW samples lose function
   resolution.
4. **Apple notarization and Windows AV are real ship-blockers**, not
   theoretical concerns.

---

## Recommendation

| Direction | Recommendation |
| --- | --- |
| **Compiler/linker knobs** | ✅ Pursue. The experiment workflow gives real numbers per-platform. The PR's Cargo.toml change (extending `opt-level="s"` to three more diagnostic crates) is a small additive win in this category. |
| **Linux UPX**            | ⚠️ Possible but not recommended. **Empirically ~70% on-disk reduction (51.2 MB → 15.5 MB with `upx --best --lzma`)** traded for first-load latency, AV-flagging risk, lost shared-page memory savings, and broken stack symbolication. |
| **macOS compressors**    | ❌ Don't pursue. Notarization is the binding constraint. |
| **Windows compressors**  | ❌ Don't pursue. AV-flagging makes UPX-packed DLLs unsafe to ship via `npm install`. |
| **Tarball-layer tricks** | ✅ Already done by npm (gzip). zstd-compressed npm tarballs are a registry-side concern, not ours. |

---

## How to reproduce the empirical findings in this report

```bash
# Linux: confirm UPX packs ELF .so and the result still dlopens.
cp -L /lib/x86_64-linux-gnu/libz.so.1 /tmp/orig.so
cp /tmp/orig.so /tmp/packed.so && chmod +x /tmp/packed.so
upx --lzma /tmp/packed.so
ls -l /tmp/orig.so /tmp/packed.so

cat > /tmp/dlopen_test.c <<'EOF'
#include <dlfcn.h>
#include <stdio.h>
int main(int argc, char **argv) {
    void *h = dlopen(argv[1], RTLD_NOW);
    if (!h) { printf("dlopen FAILED: %s\n", dlerror()); return 1; }
    printf("dlopen OK\n");
    return 0;
}
EOF
gcc /tmp/dlopen_test.c -ldl -o /tmp/dlopen_test
/tmp/dlopen_test /tmp/orig.so      # dlopen OK
/tmp/dlopen_test /tmp/packed.so    # dlopen OK

# Same again under Node:
node -e 'try { process.dlopen({exports:{}}, "/tmp/packed.so"); }
         catch(e){ console.log(e.message); }'
# -> "Module did not self-register" = the loader accepted the .so;
#    libz simply isn't a NAPI module.
```

Versions used for the empirical Linux entry: UPX 4.2.2, Node 22.22.2,
glibc on Ubuntu 24.04 / x86_64.
