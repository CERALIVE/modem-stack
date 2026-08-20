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

encoded_password="$(printf '%s' "$MF79U_BENCH_PASSWORD" | base64 | tr -d '\n')"
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
if [[ "$response_body" == *'"result"'* ]]; then
	printf '%s\n' 'auth-rejection'
	exit 3
fi
if [[ "$response_body" == *'"LD"'* ]] || [[ "$response_body" == *'LOGIN_MULTI_USER'* ]]; then
	printf '%s\n' 'protocol-mismatch'
	exit 2
fi

printf '%s\n' 'lockout-unknown'
exit 4
