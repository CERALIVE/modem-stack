#!/usr/bin/env bash
set -euo pipefail

: "${MF79U_BENCH_PASSWORD:?set MF79U_BENCH_PASSWORD for this one bench attempt}"
: "${MF79U_REDACTED_CAPTURE:?set MF79U_REDACTED_CAPTURE to one redacted browser request shape}"

admin_url="${MF79U_ADMIN_URL:-http://192.168.0.1}"
interface_name="${MF79U_INTERFACE:-usb0}"
expected_shape=$'METHOD POST\nPATH /goform/goform_set_cmd_process\nHEADER content-type\nHEADER origin\nHEADER referer\nFORM goformId\nFORM isTest\nFORM password'

if [[ ! -r "$MF79U_REDACTED_CAPTURE" ]] || [[ "$(<"$MF79U_REDACTED_CAPTURE")" != "$expected_shape" ]]; then
	printf '%s\n' 'protocol-mismatch'
	exit 2
fi

headers_file="$(mktemp)"
chmod 600 "$headers_file"
trap 'rm -f "$headers_file"' EXIT

evidence_cmd='LD,psw_fail_num_str,login_lock_time,wa_inner_version,cr_version'
evidence_body="$(curl --silent --show-error --max-time 10 --interface "$interface_name" \
	--get \
	--data-urlencode 'isTest=false' \
	--data-urlencode "cmd=$evidence_cmd" \
	--data 'multi_data=1' \
	--header "Origin: $admin_url" \
	--header "Referer: $admin_url/index.html" \
	"$admin_url/goform/goform_get_cmd_process")"

remaining_attempts="$(jq -er '.psw_fail_num_str | tonumber' <<<"$evidence_body")" || {
	printf '%s\n' 'protocol-mismatch'
	exit 2
}
lock_time="$(jq -er '.login_lock_time | tonumber' <<<"$evidence_body")" || {
	printf '%s\n' 'protocol-mismatch'
	exit 2
}
if (( lock_time > 0 || remaining_attempts <= 0 )); then
	printf '%s\n' 'lockout'
	exit 4
fi

ld="$(jq -er '.LD // empty' <<<"$evidence_body")" || true
wa_version="$(jq -er '.wa_inner_version // empty' <<<"$evidence_body")" || true
if [[ -n "$ld" && "$wa_version" == *MF79U* ]]; then
	inner="$(printf '%s' "$MF79U_BENCH_PASSWORD" | sha256sum | cut -d' ' -f1 | tr '[:lower:]' '[:upper:]')"
	encoded_password="$(printf '%s%s' "$inner" "$ld" | sha256sum | cut -d' ' -f1 | tr '[:lower:]' '[:upper:]')"
elif [[ -z "$ld" && "$wa_version" == *MF79U* ]]; then
	encoded_password="$(printf '%s' "$MF79U_BENCH_PASSWORD" | base64 | tr -d '\n')"
else
	printf '%s\n' 'protocol-mismatch'
	exit 2
fi
request_body="goformId=LOGIN&isTest=false&password=$(printf '%s' "$encoded_password" | jq -sRr @uri)"

response_body="$({
	printf '%s' "$request_body"
} | curl --silent --show-error --max-time 10 --interface "$interface_name" \
	--request POST \
	--header 'Content-Type: application/x-www-form-urlencoded; charset=UTF-8' \
	--header "Origin: $admin_url" \
	--header "Referer: $admin_url/index.html" \
	--data-binary @- \
	--dump-header "$headers_file" \
	"$admin_url/goform/goform_set_cmd_process")"

if [[ "$response_body" == *'"result":"0"'* ]] && grep -Eiq '^set-cookie:[[:space:]]*stok=' "$headers_file"; then
	printf '%s\n' 'auth-accepted'
	exit 0
fi
if [[ "$response_body" == *'"result":"3"'* ]]; then
	printf '%s\n' 'auth-rejection'
	exit 3
fi
if [[ "$response_body" == *'"result":"1"'* ]] || [[ "$response_body" == *'"result"'* ]]; then
	printf '%s\n' 'protocol-mismatch'
	exit 2
fi

printf '%s\n' 'protocol-mismatch'
exit 2
