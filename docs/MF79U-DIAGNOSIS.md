# MF79U authentication diagnosis `[PARTIAL]`

This bench-only procedure distinguishes an MF79U legacy protocol mismatch from a rejected
credential or an unknown lockout state. It performs **at most one** login request. It never
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

- Install `curl`, `jq`, and GNU `base64`. Do not enable shell tracing.

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

- `auth-accepted` — the legacy request returned success and a `stok` cookie.
- `protocol-mismatch` — the redacted browser shape differs, or the reply has MF266 challenge
  markers. Stop; do not try another algorithm.
- `auth-rejection` — the device returned a defined negative result. Confirm the credential
  out of band before any later attempt.
- `lockout-unknown` — the response cannot distinguish a lockout from another refusal. Stop
  all authentication attempts and inspect the device UI manually.

Only the classification file may be retained. The redacted browser shape and classification
remain under gitignored `test-results/`; never retain the temporary password or a raw capture.
