<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## Huawei HiLink provider (Todo 24)

`control/src/providers/huawei-hilink/` is the concrete network provider for two exact replay-backed firmware profiles: `e3372h-22.200-password-type-3` and `e3372h-22.333-password-type-4`. The evidence matcher first requires the exact firmware and an unauthenticated `SesTokInfo` document, then makes ONE profile-selected login attempt only after `state-login` confirms that profile's password type. It never tries the neighbouring algorithm. Unknown firmware and profile mismatches receive no operations surface.

Every HTTP request is interface-bound and redirect-disabled. Credentials, password derivatives, cookies and tokens stay in memory and never enter errors or contract fixtures. Status, signal, network-mode and mobile-data capabilities are probed separately; only mode and mobile-data have writes, and Wi-Fi has no operation at all. Writes serialize per physical modem, acquire the non-queueing `router-session` ownership lease, preflight their own capability, and use a newly authenticated session for exact readback before `applied`. A `125002` or HTTP 401/403 during the write refuses `auth-expired` without another login attempt. Pure XML parsing remains centralized in `hardware/router-parsers` through `hardware/hilink-protocol.ts`.

