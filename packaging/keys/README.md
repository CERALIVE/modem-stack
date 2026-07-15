# packaging/keys — signer public keys for `upstream-pins.yaml`

Armored public keys of the Debian Developers whose GPG signatures on the `.dsc`
files authenticate the tarball checksums pinned in `../upstream-pins.yaml`.
`../ci/verify-upstream-pins.sh` imports these into an **isolated** `GNUPGHOME`
(never the caller's `~/.gnupg`) and verifies each source's `.dsc` against the
`signer_fingerprint` pinned for that source.

Keys are named by full 40-hex fingerprint, not by source, because one key signs
several sources (Guido Günther signs modemmanager, libmbim, libqmi). Fingerprint
naming keeps a single copy per key — a key rotation updates one file, not three —
and the manifest maps each source to its key via the `signer_key_file` field.

## Keys

| File | Fingerprint | Owner (UID) | Signs |
|------|-------------|-------------|-------|
| `63F6CCDF96229D09286B2AC325BF86524AFCC1E3.asc` | `63F6 CCDF 9622 9D09 286B  2AC3 25BF 8652 4AFC C1E3` | Guido Günther `<agx@sigxcpu.org>` (DebianOnMobile team) | modemmanager 1.24.0-1, libmbim 1.32.0-1, libqmi 1.36.0-1 |
| `796DB393DC3FF40222B6EA22D3EBB5966BB99196.asc` | `796D B393 DC3F F402 22B6  EA22 D3EB B596 6BB9 9196` | Arnaud Ferraris `<arnaud.ferraris@gmail.com>` (DebianOnMobile team) | libqrtr-glib 1.2.2-1 |

## Acquisition source (documented per the plan)

Both keys were fetched from the **authoritative Debian keyring keyserver**
`hkps://keyring.debian.org` on 2026-07-14 and re-exported with
`--export-options export-minimal` (strips third-party certifications, keeps the
self-signatures needed for validity), then armored:

```sh
GNUPGHOME=$(mktemp -d)                    # isolated — never ~/.gnupg
gpg --keyserver hkps://keyring.debian.org --recv-keys \
    63F6CCDF96229D09286B2AC325BF86524AFCC1E3 \
    796DB393DC3FF40222B6EA22D3EBB5966BB99196
gpg --export-options export-minimal --armor \
    --export 63F6CCDF96229D09286B2AC325BF86524AFCC1E3 \
    > 63F6CCDF96229D09286B2AC325BF86524AFCC1E3.asc
gpg --export-options export-minimal --armor \
    --export 796DB393DC3FF40222B6EA22D3EBB5966BB99196 \
    > 796DB393DC3FF40222B6EA22D3EBB5966BB99196.asc
```

`keyring.debian.org` is the correct root of trust here: it serves exactly the
keys in the active Debian keyring (`debian-keyring`), i.e. the developers
permitted to upload to the Debian archive — the same identities that signed
these `.dsc` files. (keys.openpgp.org was tried first but does not carry the
Guido Günther key with usable UIDs, so the Debian keyring is the canonical source.)

## How the fingerprint was established (not trusted blindly)

The fingerprint for each source was read **from the signature on the real `.dsc`**,
not assumed:

```sh
gpg --verify modemmanager_1.24.0-1.dsc   # -> "using RSA key 63F6CCDF...C1E3"
gpg --verify libqrtr-glib_1.2.2-1.dsc    # -> "using RSA key 796DB393...9196"
```

So the checked-in key matches the key that actually produced each signature. The
verify script re-establishes this end-to-end: import key -> `gpg --verify` the
downloaded `.dsc` -> confirm the reported signing key equals the pinned
`signer_fingerprint`.

## Note on the Arnaud Ferraris key expiry

`796DB393…9196` shows an expiry (visible in `gpg --list-keys`), but the
libqrtr-glib 1.2.2-1 `.dsc` signature was made while the key was valid, so
`gpg --verify` still reports **Good signature** and exits 0. GPG validates a
signature against the key's state *at signing time*, not at verification time;
later expiry does not retroactively invalidate a signature that was good when made.
