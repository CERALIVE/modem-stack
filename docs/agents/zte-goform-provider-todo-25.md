<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## ZTE GOFORM PROVIDER (TODO 25)

`control/src/providers/zte-goform/` owns three incompatible, exact replay-backed profiles:
`mf79u-legacy` uses `LOGIN` with a base64 password; `mf79u-ld-salted` uses the same bare
`LOGIN` with `SHA256(SHA256(password)+LD)` (the MF79U B03 dialect); and `mf266-salted` uses
`LOGIN_MULTI_USER` with the salted hash, `stok`, `RD`, and derived `AD`. A batched pre-auth
`multi_data` GET reads `LD`, remaining attempts, lock time, and both version fields. That
evidence selects the algorithm and refuses a positive lockout before any credential POST;
firmware text alone never selects an encoding. The selected algorithm receives one bounded
attempt and never falls through to another profile. Cookies and derivatives are memory-only and sanitized fixtures expose only
redaction markers. Unknown firmware may match the ZTE response shape but receives only the
`zte-unknown-read-only` operation surface. All ZTE operation surfaces are currently read-only;
in particular `wifi.enabled` is absent until a safe write plus readback is captured.

The bench-only harness `control/scripts/mf79u-diagnose.sh` requires
`MF79U_BENCH_PASSWORD` and one redacted browser request-shape manifest. It performs at most
one login request and emits only `auth-accepted`, `protocol-mismatch`, `auth-rejection`, or
`lockout`; see `docs/MF79U-DIAGNOSIS.md`.

