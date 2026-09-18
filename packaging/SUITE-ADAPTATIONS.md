# Suite adaptations

**Target suite: `trixie` (Debian 13).** It is the suite the CeraLive device image runs, and
the build container is `debian:$TARGET_SUITE` in
[`ci/build-stack.sh`](ci/build-stack.sh) — a variable, not a literal, because the build suite
and the target suite must agree. A stack built against a newer libc than the board ships
fails at load with a `GLIBC_` symbol error that no build step can observe, so
`build-stack.sh` asserts the container's own `VERSION_CODENAME` equals `TARGET_SUITE` and
**refuses the build** on drift. Parity is a gate here, not a convention.

The four sources are rebuilt from their **pinned sid `debian/<ver>-<rev>` packaging**
([`upstream-pins.yaml`](upstream-pins.yaml) `salsa_commit_sha`). libmbim, libqmi, and
libqrtr-glib carry zero source patches. ModemManager carries only the project-owner-approved,
three-patch BELABOX-derived FM350-GL series documented in
[`ADR-FM350-RNDIS-BEARER.md`](../docs/adr/ADR-FM350-RNDIS-BEARER.md) and
[`POLICY.md`](../POLICY.md).

That pinned packaging is **sid packaging, and sid is ahead of trixie** — so it does not build
unmodified here either. A small set of **packaging-metadata** adaptations is applied, limited
to the pre-authorized salsa-deviation class: `debian/control` build-dependency
relaxations/substitutions and `debian/rules` meson/install-path pins. Nothing else — no
maintainer-script changes, no package add/remove/rename, no `Breaks`/`Replaces`/`Conflicts`
edits, and no symbols regeneration.

Each `debian/` dir here is byte-identical to the pinned salsa commit **except** for the hunks
and ModemManager patch series below. Symbols files are **byte-preserved** from the salsa tree;
any need to regenerate a symbols file is a HARD STOP, not a local fix.

**Bases:** ModemManager `1.24.2-2`, libmbim `1.34.0-1`, libqmi `1.38.0-1`,
libqrtr-glib `1.4.0-1`.

## Why the adaptation set survived the bookworm → trixie move unchanged

These adaptations were originally derived to build sid packaging on **bookworm**. The obvious
expectation on moving to trixie is that they can all be reverted, since trixie is much closer
to sid. **That expectation is wrong for the GI adaptation and wrong for the install-dir pins**,
and each verdict below was re-measured in a `debian:trixie` container rather than reasoned
about. The measured environment:

| Package | trixie | Consequence |
|---|---|---|
| `gobject-introspection` | `1.84.0-1` | sid's `(>= 1.80)` **is** satisfiable here |
| `libgirepository1.0-dev` | `1.84.0-1` | the adapted build-dep **still exists** on trixie |
| `gir1.2-glib-2.0-dev` | `2.84.4-3~deb13u3` | real package |
| `gir1.2-gio-2.0-dev` | **virtual** | `Provides:` of `gir1.2-glib-2.0-dev` |
| `gir1.2-gobject-2.0-dev` | **virtual** | `Provides:` of `gir1.2-glib-2.0-dev` |
| `debhelper` | `13.24.2` | satisfies both `>= 13.11.4` and `>= 13.11.6` |
| `systemd-dev` | `257.13-1~deb13u1` | present — unlike bookworm |
| `udev` | `257.13-1~deb13u1` | present, but ships **no `.pc` file at all** |
| `policykit-1` | **absent** | replaced by `polkitd` (see the smoke note below) |

The decisive measurement is the last `udev` row. On bookworm the install-dir pins were needed
because `systemd.pc` was missing from `udev`; on trixie **both** `udev.pc` and `systemd.pc`
have moved into `systemd-dev`, so a `udev` build-dep supplies neither. The pins are therefore
*more* load-bearing on trixie than they were on bookworm, and adaptations 2 and 3 below are a
**coherent pair** — reverting the build-dep without the pins, or the pins without the
build-dep, breaks the build.

**Verdict: the adaptation set is retained verbatim.** Every adapted `debian/control` resolves
on trixie (`apt-get build-dep --dry-run`, exit 0, all four sources), and the full four-source
build is green. Reverting the GI block would be a no-op at best (both forms resolve, because
the two sid-only `gir1.2-*` names are satisfied virtually) while re-opening a verified
deviation surface for nothing.

## The GObject-introspection adaptation — ALL FOUR sources

The DebianOnMobile maintainers modernized the introspection build-deps: they dropped
`libgirepository1.0-dev` and switched to a split, multiarch-friendly set —
`gobject-introspection (>= 1.80)` plus explicit `gir1.2-<lib>-2.0-dev` packages. The changelog
rationale is explicit and identical across sources, e.g. libmbim `1.32.0-2` / MM `1.24.2-2`:

> `libgirepository1.0-dev` shouldn't be used anymore as it isn't multiarch-friendly. Instead,
> use a recent `gobject-introspection` and explicitly (build) depend on the needed
> `gir1.2-*-dev` packages. (MM: Closes #1118899 / #1087277 "Improve cross building".)

That switch is a **Debian archive/cross-build policy** choice, **not** an upstream feature
requirement — which is why substituting the older spelling is safe.

### Adaptation — `debian/control` (each source)

```
-               gir1.2-gio-2.0-dev,
-               gir1.2-glib-2.0-dev,        (MM + libmbim only; libqmi/libqrtr-glib omit it)
-               gir1.2-gobject-2.0-dev,
-               gobject-introspection (>= 1.80),
+               gobject-introspection,
+               libgirepository1.0-dev,
```

Nothing else in any `control` is touched by this adaptation.

### Why it is retained on trixie

- **It resolves.** `libgirepository1.0-dev` is a real, current package on trixie (`1.84.0-1`),
  so the adapted form needs no change.
- **Upstream floor.** All four `meson.build` files gate introspection on
  `dependency('gobject-introspection-1.0', version: '>= 0.9.6')` (MM l.295, libmbim l.185,
  libqmi l.235, libqrtr-glib l.139) — far below anything either spelling provides.
- **Functionally proven, not assumed.** The daemon smoke loads the built
  `gir1.2-modemmanager-1.0` typelib through PyGObject and reads a real enum, and compiles +
  links a Vala program against `libmm-glib` via `valac -C` → `cc $(pkg-config … mm-glib)`.
  Both pass on trixie, so the introspection and VAPI outputs are ABI-valid, not merely present.

## libqrtr-glib, libmbim, libqmi — only the GI adaptation

Beyond the shared GI substitution, these three build unmodified. Their `control` carries no
trixie-unsatisfiable build-dep, their `rules` needs no pins, and their only cross-source
build-deps (`libqmi` → `libqrtr-glib-dev` + `libmbim-glib-dev`) are satisfied by the freshly
built packages in the temporary local apt repo — the bootstrap build order, not a packaging
change. `debian/rules`, maintainer scripts, symbols, and every other `debian/` file are
pristine salsa copies.

## ModemManager — three adaptations beyond the GI substitution

### 1. debhelper version relax — `debian/control`

`debhelper (>= 13.11.6)` → `debhelper (>= 13.11.4)`. Compat level is unchanged
(`debhelper-compat (= 13)`).

**On trixie this is a no-op**: debhelper is `13.24.2`, which satisfies the original floor. It
is retained only because reverting it changes a verified `debian/` tree to no effect. It is the
one adaptation here that could be dropped safely, and the one with the least reason to be.

### 2. `systemd-dev` → `udev` build-dep — `debian/control`

`libsystemd-dev (>= 209)` is kept unchanged (it links libsystemd for journal / suspend-resume
and is unrelated to `systemd-dev`).

**On trixie `systemd-dev` exists**, so this substitution is no longer forced by availability.
It is retained as the working half of the coherent pair with adaptation 3: with `udev` alone,
neither `udev.pc` nor `systemd.pc` is present, and the pins below are what make that fine.

### 3. systemd + udev install-dir pins — `debian/rules`

Two meson flags in `override_dh_auto_configure` (companions to adaptation 2):

```
+		-Dsystemdsystemunitdir=/usr/lib/systemd/system \
+		-Dudevdir=/usr/lib/udev \
```

- **`systemdsystemunitdir`** — MM's `meson.build` (l.209) calls `dependency('systemd')` when
  the option is left empty, to read `systemdsystemunitdir` from `systemd.pc`. Under adaptation
  2 that `.pc` is absent, so `dependency('systemd')` would fail *"systemd required but not
  found"*. Pinning the dir makes meson skip the lookup entirely.
- **`udevdir`** — likewise skips the `udev.pc` lookup. Both pinned values are the usr-merged
  paths the sid `modemmanager.install` hardcodes (`usr/lib/systemd`, `usr/lib/udev`), which are
  correct on trixie.

## ModemManager — approved FM350-GL source patch series

`ModemManager/debian/patches/series` carries exactly three patches against the pinned
ModemManager 1.24.2 source:

1. A 1.24-native forward-port of BELABOX's FM350-GL USB/RNDIS bearer and `+GTACT` mode
   handling, derived from commits `da01610c46c581b0c6f2acd0ac50f5bba666efdf`,
   `419dc598d3f2c11f479dacdc2f6ef0e787e6ea3b`,
   `90bcd376405906d3a94b0c239689eef1a3899ed2`,
   `9e2bc4992a251b02f75280a2d2b1020227d2bfe8`, and
   `9716d38b6a81a79b47a16ea96c27164219de6739`.
2. The FM350 CPOL crash-disable row from
   `b4377c5028a0de4435b86f7aad9114e9443d69e4`.
3. The extended `+COPS` parser fix and regression test from
   `43e09a768e3855f3afb93e517902c1e0e25ed676`.

All three retain BELABOX author `rationalsa <belaboxproject@gmail.com>` and record
`Forwarded: no`. The project owner approved this exact carry on 2026-08-22 under the narrow
POLICY exception. Builds prove source compatibility only; the real-board bearer drill remains
required before any hardware support claim.

## One CI-side trixie change that is NOT a packaging adaptation

`ci/daemon-smoke.sh` installed `policykit-1`, which **does not exist on trixie** — it was a
bookworm transitional package and the daemon is now `polkitd`. The smoke installs `polkitd`.
This is test-harness plumbing, not a `debian/` deviation, and no source recipe references it.

## Summary of the deviation surface

| Source        | `debian/control`                                   | `debian/rules`            | Source patches |
|---------------|----------------------------------------------------|---------------------------|----------------|
| ModemManager  | GI swap; debhelper `13.11.6`→`13.11.4`; `systemd-dev`→`udev` | +2 meson install-dir pins | 3-patch FM350-GL series above |
| libmbim       | GI swap                                             | (pristine)                | none |
| libqmi        | GI swap                                             | (pristine)                | none |
| libqrtr-glib  | GI swap                                             | (pristine)                | none |

No other `debian/` file differs from the pinned salsa tree for any source.
