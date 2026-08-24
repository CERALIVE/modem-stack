# MF79U authentication diagnosis `[PARTIAL]`

This bench-only procedure distinguishes the two MF79U login encodings from a rejected
credential or a lockout. It performs **at most one** login request. Before that attempt it
reads `LD`, `psw_fail_num_str`, `login_lock_time`, `wa_inner_version`, and `cr_version` in
one batched `multi_data` GET. It never
retries, never tries the MF266 algorithm, and never writes Wi-Fi or modem configuration.

## Preconditions

- Connect one MF79U and identify its USB-network interface.
- In browser developer tools, capture the login request once, redact every value, and save
  only this request-shape manifest outside the repository (for example under
  `test-results/`):

  ```text
  METHOD POST
  PATH /goform/goform_set_cmd_process
  HEADER content-type
  HEADER origin
  HEADER referer
  FORM goformId
  FORM isTest
  FORM password
  ```

- Install `curl`, `jq`, GNU `base64`, `sha256sum`, and `cut`. Do not enable shell tracing.

## One-attempt command

Run from the repository root. Inject the password only into the command environment; do not
put it in a shell script, transcript, issue, or evidence file.

```sh
read -rsp 'MF79U bench password: ' MF79U_BENCH_PASSWORD; printf '\n'
export MF79U_BENCH_PASSWORD
MF79U_INTERFACE=usb0 \
MF79U_ADMIN_URL=http://192.168.0.1 \
MF79U_REDACTED_CAPTURE=test-results/mf79u-login-shape.txt \
  control/scripts/mf79u-diagnose.sh |
  tee test-results/mf79u-diagnosis.txt
unset MF79U_BENCH_PASSWORD
```

The output is exactly one classification and contains no response body, cookie, password,
or derivative:

- `auth-accepted` — the evidence-selected request returned result `"0"` and a `stok` cookie.
- `protocol-mismatch` — the evidence is incomplete, names another device family, the login
  shape is unrecognized, or the login returns result `"1"`. Stop; do not try another algorithm.
- `auth-rejection` — the device returned result `"3"`. Confirm the credential
  out of band before any later attempt.
- `lockout` — `login_lock_time` is positive or `psw_fail_num_str` reports no remaining
  attempts. No login POST was sent; inspect the device UI and wait for or clear the lockout.

When `LD` is absent on MF79U firmware, the password field is base64. When `LD` is present
on MF79U firmware — including `BD_XCBZHKMF79UV1.0.0B03` — the same bare `LOGIN` form carries
`SHA256(SHA256(password)+LD)`. That is distinct from MF266's `LOGIN_MULTI_USER` form even
though both use the same nested hash.

Only the classification file may be retained. The redacted browser shape and classification
remain under gitignored `test-results/`; never retain the temporary password or a raw capture.
