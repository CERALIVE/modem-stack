# Bookworm adaptations

The four sources are rebuilt from their **pinned trixie `debian/<ver>-1` packaging**
([`upstream-pins.yaml`](upstream-pins.yaml) `salsa_commit_sha`) — **zero source patches**
(`debian/patches/` is empty for every source; see [`POLICY.md`](../POLICY.md)). The trixie
packaging does not build unmodified on bookworm, so a small set of **packaging-metadata**
adaptations is applied. This file records every one of them and why.

Each `debian/` dir here is byte-identical to the pinned salsa commit **except** for the
hunks below. Reproduce the delta with `test-results/modem-control/A5.1/debdiff.txt`
(a recursive diff of each adapted `debian/` against the salsa tree at its pinned SHA).

## libqrtr-glib, libmbim, libqmi — zero adaptations

These three build unmodified on bookworm. Their `debian/` dirs are pristine copies of the
pinned salsa commits. Their only cross-source build-deps (`libqmi` → `libqrtr-glib-dev`,
`libmbim-glib-dev`) are satisfied by the freshly built packages in the temporary local apt
repo — that is what the bootstrap build order exists for, not a packaging change.

## ModemManager — three adaptations (all in `debian/control` + `debian/rules`)

The trixie `modemmanager 1.24.0-1` packaging assumes a **trixie** build environment. Three
things differ on bookworm; each adaptation is the minimal, bookworm-native fix.

### 1. debhelper version relax (documented) — `debian/control`

`debhelper (>= 13.11.6)` → `debhelper (>= 13.11.4)`. Bookworm ships debhelper **13.11.4**;
the trixie packaging pinned `>= 13.11.6`, which is unsatisfiable on bookworm. Compat level
is unchanged (`debhelper-compat (= 13)`, provided by bookworm's debhelper). Nothing the
build needs from 13.11.6 is used.

### 2. `systemd-dev` → `udev` build-dep (documented) — `debian/control`

`systemd-dev` is a **trixie/forky-only** package that does not exist in bookworm. In trixie
it ships **both** `udev.pc` (for the udev base dir) **and** `systemd.pc` (for the systemd
system-unit dir). On bookworm those two `.pc` files are split across separate packages:
`udev.pc` is in `udev`, `systemd.pc` is in `systemd`. The substitution restores the `udev.pc`
half. `libsystemd-dev (>= 209)` is kept unchanged (it links libsystemd for journal /
suspend-resume and is unrelated to `systemd-dev`).

### 3. systemd + udev install-dir pins (**adaptation beyond the two documented ones — see below**) — `debian/rules`

Two meson flags added to `override_dh_auto_configure`:

```
-Dsystemdsystemunitdir=/usr/lib/systemd/system
-Dudevdir=/usr/lib/udev
```

Both are **required companions to adaptation 2** and are why this is more than a one-token
build-dep swap:

- **`systemdsystemunitdir`** — MM's `meson.build` calls `dependency('systemd')` whenever the
  option is left empty (its default), to read `systemdsystemunitdir` from `systemd.pc`. In
  trixie that `.pc` came from `systemd-dev`; after swapping to `udev` it is gone (bookworm's
  `udev` ships only `udev.pc`), so `dependency('systemd')` fails with *"systemd required but
  not found"*. Pinning the dir explicitly makes meson skip the `dependency('systemd')` call
  entirely — exactly what **stock bookworm `modemmanager 1.20.4-1` does** (it build-deps on
  `udev` and pins `-Dsystemdsystemunitdir=/lib/systemd/system` in its own `debian/rules`).
- **`udevdir`** — bookworm's `udev.pc` reports `udevdir = /lib/udev` (non-usr), but the trixie
  `modemmanager.install` hardcodes usr-merged paths (`usr/lib/systemd`, `usr/lib/udev`). Left
  unpinned, meson installs udev files to `/lib/udev` and `dh_install` aborts with *"missing
  files: usr/lib/udev"*. Pinning `udevdir` (and using the usr-merged `/usr/lib/systemd/system`
  for the unit dir) makes the install paths match the trixie `.install` files.

## STOP-and-surface note: the documented adaptation set was incomplete

The plan (A5.1) and draft documented exactly **two** adaptations: debhelper relax and
`systemd-dev → udev`. Empirically, those two alone **do not** produce a clean ModemManager
build on bookworm — the build fails first at meson (`dependency('systemd')` not found) and,
once that is worked around, again at `dh_install` (usr-merged path mismatch). Adaptation 3
(the two `debian/rules` install-dir pins) is the minimal fix and is precisely what Debian's
own bookworm MM packaging does. It is **packaging metadata, not a source patch**: `debian/`
config only, upstream source untouched, `debian/patches/` still empty — so it does not
trip the [`POLICY.md`](../POLICY.md) no-fork gate. It is surfaced here (rather than applied
silently) because it extends the documented adaptation list; the plan/draft adaptation list
should be corrected to name these systemd/udev install-dir pins as the third bookworm
adaptation for ModemManager.
