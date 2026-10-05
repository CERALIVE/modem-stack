<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## FIRST-PARTY COMPANION — `ceralive-modem-support`

The first-party `ceralive-modem-support` package keeps CeraLive-owned system assets out of
all four upstream recipes; the ModemManager FM350-GL source series is a separate, narrowly
approved exception and owns no companion asset. The companion
(`packaging/ceralive-modem-support/`, `Architecture: all`) owns the UNCONDITIONAL, generic
modem system assets — CeraLive's identification-only udev rules, Zero-CD usb-modeswitch
device data, and the FCC policy-reconciliation helper plus its oneshot unit. It ships **no
FCC-unlock script at all**; an absent `/data/ceralive/fcc-unlock-policy.json` exits 0 and activates nothing,
which is also the correct behaviour on generic Debian with no CeraLive partition layout.

**Board-gated generated assets stay image-owned** — M.2 SIM quirk rows and per-slot modem UID
rules consume build-time board facts a generic package cannot know. Do not move them here.

**The udev basename is load-bearing.** udev resolves rules by BASENAME, and an
`/etc/udev/rules.d` file SHADOWS a same-basename `/usr/lib/udev/rules.d` file completely
while `dpkg -S` keeps naming the package as owner of the `/usr/lib` path — the substitution
is invisible to package tooling. The companion therefore uses the modem-only basename
`60-ceralive-modem.rules`, which no image-owned `/etc` file shares (the image owns
`99-ceralive-hardware.rules` and `78-mm-ceralive-slot-uid.rules`). Never rename it onto an
image-owned basename, and never ship an `/etc` copy from this package. A stale same-basename
`/etc` override is removed on upgrade ONLY when marker AND sha256 identify a known generated
payload; anything unknown or operator-modified is preserved.

QA is two-stage and the split is deliberate: `packaging/ci/test-companion-chroot.sh` proves
packaging SHAPE in a clean `debian:trixie` container, while the consumer proofs (`udevadm
test` against a real modem, `usb_modeswitch -c`, unit ordering against a real boot journal)
are BENCH-GATED and must not be faked in a container. Full detail: `packaging/README.md`.

The release manifest emits **`closure_version: 2`**, which adds this one `Architecture: all`
asset to the frozen 9 × 2 closure as a single row with `build_arch` `all`. It is ONE
immutable release asset with TWO index memberships; apt-worker's publisher indexes it into
both per-arch indexes. A per-arch build is forbidden — two byte-different files under one
package/version key break the immutable-key rule.

