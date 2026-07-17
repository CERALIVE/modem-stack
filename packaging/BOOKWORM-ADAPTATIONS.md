# Bookworm adaptations

The four sources are rebuilt from their **pinned sid/trixie `debian/<ver>-<rev>` packaging**
([`upstream-pins.yaml`](upstream-pins.yaml) `salsa_commit_sha`) — **zero source patches**
(`debian/patches/` is empty for every source; see [`POLICY.md`](../POLICY.md)). The sid
packaging does not build unmodified on bookworm, so a small set of **packaging-metadata**
adaptations is applied, limited to the pre-authorized salsa-deviation class: `debian/control`
build-dependency relaxations/substitutions and `debian/rules` meson/install-path pins that
mirror stock bookworm's own packaging of the same source. Nothing else — no maintainer-script
changes, no package add/remove/rename, no `Breaks`/`Replaces`/`Conflicts` edits, no symbols
regeneration, no `debian/patches/` content. This file records every adaptation and why.

Each `debian/` dir here is byte-identical to the pinned salsa commit **except** for the hunks
below. The delta is captured per source as a recursive diff against the raw salsa tree at its
pinned SHA — `test-results/upstream-currency/1.2/debdiff-<source>.txt` (×4). Symbols files are
**byte-preserved** from the salsa tree (verified sha256-identical); any need to regenerate a
symbols file is a HARD STOP, not a local fix.

**Bases (this bump):** ModemManager `1.24.2-2`, libmbim `1.34.0-1`, libqmi `1.38.0-1`,
libqrtr-glib `1.4.0-1`. All four adaptation sets were **re-derived** against these NEW bases
(the prior derivation targeted the older `1.24.0-1`/`1.32.0`/`1.36.0`/`1.2.2` packaging).

## The GObject-introspection adaptation — ALL FOUR sources (NEW this bump)

The single new, cross-cutting adaptation. Between the previously-pinned revisions and these,
the DebianOnMobile maintainers **modernized the introspection build-deps** on every source:
they dropped `libgirepository1.0-dev` and switched to a split, multiarch-friendly set —
`gobject-introspection (>= 1.80)` plus explicit `gir1.2-<lib>-2.0-dev` packages. The changelog
rationale is explicit and identical across sources, e.g. libmbim `1.32.0-2` / MM `1.24.2-2`:

> `libgirepository1.0-dev` shouldn't be used anymore as it isn't multiarch-friendly. Instead,
> use a recent `gobject-introspection` and explicitly (build) depend on the needed
> `gir1.2-*-dev` packages. (MM: Closes #1118899 / #1087277 "Improve cross building".)

That switch is a **Debian archive/cross-build policy** choice, **not** an upstream feature
requirement. On bookworm it is unsatisfiable two ways:

- `gobject-introspection` in bookworm is **1.74.0-3** — `(>= 1.80)` cannot be met.
- the split `gir1.2-gio-2.0-dev` / `gir1.2-glib-2.0-dev` / `gir1.2-gobject-2.0-dev` packages
  **do not exist** in bookworm at all (they are a GI-1.80-era packaging split).

### Adaptation — `debian/control` (each source)

Replace the sid GI-1.80 build-dep block with bookworm's GI-1.74 equivalent:

```
-               gir1.2-gio-2.0-dev,
-               gir1.2-glib-2.0-dev,        (MM + libmbim only; libqmi/libqrtr-glib omit it)
-               gir1.2-gobject-2.0-dev,
-               gobject-introspection (>= 1.80),
+               gobject-introspection,
+               libgirepository1.0-dev,
```

Nothing else in any `control` is touched by this adaptation; the doc tooling each source now
uses (`gi-docgen` for libqmi/libqrtr-glib, `gtk-doc-tools` for MM/libmbim) and `pkgconf` are
all present in bookworm and are left exactly as upstream ships them.

### Why GI 1.74 is sufficient (empirical, not assumed)

- **Upstream floor.** All four `meson.build` files gate introspection on
  `dependency('gobject-introspection-1.0', version: '>= 0.9.6')` (MM l.295, libmbim l.185,
  libqmi l.235, libqrtr-glib l.139). Bookworm's `gobject-introspection-1.0.pc` reports
  **1.74.0** — three orders of magnitude above the required 0.9.6.
- **Functional proof.** In a `debian:bookworm` container with only `libgirepository1.0-dev`
  (GI 1.74) installed, a minimal `gnome.generate_gir()` meson project — mirroring MM's exact
  `dependency('gobject-introspection-1.0', version: '>= 0.9.6')` assertion — configures and
  builds, producing a `.gir` **and** a `.typelib` via g-ir-scanner/g-ir-compiler 1.74.
  Evidence: `test-results/upstream-currency/1.2/gi-1.74-empirical.log` (PART D).
- **Preflight proof.** The adapted MM control's external build-deps resolve on bookworm
  (`apt-get satisfy --dry-run`, exit 0, `libgirepository1.0-dev 1.74.0-3`); the UNADAPTED
  GI-1.80 control genuinely fails (exit 100) on `gobject-introspection (>= 1.80)` and the
  three missing `gir1.2-*-2.0-dev`. Evidence: `gi-1.74-empirical.log` (PARTS B/C),
  `unadapted-failure.log`.

### Stock-bookworm citation

Every one of the four sources, **as packaged in bookworm itself**, build-depends on exactly
`gobject-introspection` + `libgirepository1.0-dev` — never the split `gir1.2-*-2.0-dev` set
(`apt-cache showsrc {modemmanager,libmbim,libqmi,libqrtr-glib}` inside bookworm, captured in
`gi-1.74-empirical.log` PART A). The substitution restores precisely bookworm's own build-dep
shape. (`libgirepository1.0-dev` Depends: `gobject-introspection`, and the virtual
`dh-sequence-gir` MM/libqrtr-glib use is Provided by `gobject-introspection 1.74.0-3` — both
confirmed in the same log.)

## libqrtr-glib, libmbim, libqmi — only the GI adaptation

Beyond the shared GI substitution above, these three build unmodified on bookworm. Their
`control` carries no bookworm-unsatisfiable build-dep (`debhelper-compat (= 13)` with no
`debhelper (>= x)` floor; `pkgconf`, `gi-docgen`, `gtk-doc-tools`, `help2man` all in bookworm),
their `rules` needs no pins, and their only cross-source build-deps (`libqmi` →
`libqrtr-glib-dev` + `libmbim-glib-dev`) are satisfied by the freshly built packages in the
temporary local apt repo — the bootstrap build order, not a packaging change. `debian/rules`,
maintainer scripts, symbols, and every other `debian/` file are pristine salsa copies.

## ModemManager — three adaptations beyond the GI substitution

MM's sid `1.24.2-2` packaging assumes a **sid/trixie** build environment in three further
ways; each adaptation is the minimal, bookworm-native fix, and each mirrors stock bookworm
`modemmanager 1.20.4-1` (whose Build-Depends — captured in `gi-1.74-empirical.log` PART A —
show `udev`, `libgirepository1.0-dev`, and no `debhelper (>= 13.11.6)` floor).

### 1. debhelper version relax — `debian/control`

`debhelper (>= 13.11.6)` → `debhelper (>= 13.11.4)`. Bookworm ships debhelper **13.11.4**; the
sid packaging pins `>= 13.11.6`, unsatisfiable on bookworm. Compat level is unchanged
(`debhelper-compat (= 13)`, provided by bookworm's debhelper). Nothing the build needs from
13.11.6 is used. Stock bookworm MM carries no such floor at all.

### 2. `systemd-dev` → `udev` build-dep — `debian/control`

`systemd-dev` is a **trixie/forky-only** package absent from bookworm. In trixie it ships both
`udev.pc` (udev base dir) and `systemd.pc` (systemd system-unit dir); on bookworm those two
`.pc` files live in separate packages (`udev.pc` in `udev`, `systemd.pc` in `systemd`). The
substitution restores the `udev.pc` half — exactly what stock bookworm MM build-deps
(`udev`). `libsystemd-dev (>= 209)` is kept unchanged (it links libsystemd for journal /
suspend-resume and is unrelated to `systemd-dev`).

### 3. systemd + udev install-dir pins — `debian/rules`

Two meson flags added to `override_dh_auto_configure` (companions to adaptation 2):

```
+		-Dsystemdsystemunitdir=/usr/lib/systemd/system \
+		-Dudevdir=/usr/lib/udev \
```

- **`systemdsystemunitdir`** — MM's `meson.build` (l.209) calls `dependency('systemd')` when
  the option is left empty (its default), to read `systemdsystemunitdir` from `systemd.pc`.
  In trixie that `.pc` came from `systemd-dev`; after swapping to `udev` it is gone (bookworm's
  `udev` ships only `udev.pc`), so `dependency('systemd')` fails *"systemd required but not
  found"*. Pinning the dir explicitly makes meson skip the `dependency('systemd')` call —
  exactly what **stock bookworm `modemmanager 1.20.4-1`** does (build-deps `udev`, pins
  `-Dsystemdsystemunitdir=...` in its own `debian/rules`).
- **`udevdir`** — bookworm's `udev.pc` reports `udevdir = /lib/udev` (non-usr), but the sid
  `modemmanager.install` hardcodes usr-merged paths (`usr/lib/systemd`, `usr/lib/udev`). Left
  unpinned, meson installs udev files to `/lib/udev` and `dh_install` aborts *"missing files:
  usr/lib/udev"*. Pinning `udevdir` (and the usr-merged `/usr/lib/systemd/system` unit dir)
  makes the install paths match the `.install` files.

## Summary of the deviation surface

| Source        | `debian/control`                                   | `debian/rules`            |
|---------------|----------------------------------------------------|---------------------------|
| ModemManager  | GI-1.74 swap; debhelper `13.11.6`→`13.11.4`; `systemd-dev`→`udev` | +2 meson install-dir pins |
| libmbim       | GI-1.74 swap                                        | (pristine)                |
| libqmi        | GI-1.74 swap                                        | (pristine)                |
| libqrtr-glib  | GI-1.74 swap                                        | (pristine)                |

No other `debian/` file differs from the pinned salsa tree for any source (verified:
`test-results/upstream-currency/1.2/relationship-audit.txt` — zero binary-package
relationship-field changes, zero maintainer-script changes, zero package add/remove/rename;
`debdiff-<source>.txt` ×4 — only the hunks above).
