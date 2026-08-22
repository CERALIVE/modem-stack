#!/usr/bin/env bash
#
# Read-only USB descriptor + HIMI identity capture for the Qualcomm UFI stick.
# BENCH ONLY. docs/UFI-DIAG-PROBE.md carries the analysis procedure this bundle feeds.
#
# READ-ONLY BY CONSTRUCTION, not by policy. Every command below reads: the sysfs sweep,
# `lsusb -v`, `usb-devices`, `udevadm info -q property`, and the seven-member HIMI `get*`
# vocabulary the shipped provider is itself limited to. Nothing here rebinds a driver,
# cycles an interface, changes a USB composition, opens a diagnostic channel, or sends a
# vendor command of any kind. `control/scripts/ufi-himi-evidence.test.ts` scans this file
# for the constructs any of that would need.
#
# THE BUNDLE IS REDACTED AT CAPTURE TIME, and the rules below are the ONE implementation
# of that redaction — `--redact-filter` exists so a test can execute these exact rules
# rather than re-express them and drift. Every captured stream is filtered before it
# reaches the staging directory, and the whole staged bundle is swept afterwards; a
# surviving identifier deletes the staging directory instead of publishing it.
#
set -euo pipefail

USB_ID="${UFI_USB_ID:-05c6:9091}"
HIMI_URL="${UFI_ADMIN_URL:-http://192.168.0.1}"
HIMI_INTERFACE="${UFI_INTERFACE:-usb0}"
HIMI_USER="${UFI_ADMIN_USER:-admin}"
MARKER='[redacted]'
SCHEMA_VERSION=1

usage() {
	cat <<'EOF'
ufi-himi-capture.sh — read-only descriptor + HIMI identity capture (bench only)

  (no argument)      capture a bundle for $UFI_USB_ID (default 05c6:9091)
  --redact-filter    stdin -> stdout through the capture-time redaction rules
  --sweep <path>     scan a written file or directory for surviving identifiers
  --help             this text

Environment:
  UFI_USB_ID          vendor:product to capture          (default 05c6:9091)
  UFI_CAPTURE_DIR     bundle output directory            (default test-results/...)
  UFI_BENCH_PASSWORD  ephemeral bench admin password; absent -> HIMI step is skipped
  UFI_ADMIN_URL       HIMI base URL                      (default http://192.168.0.1)
  UFI_INTERFACE       interface to bind HIMI requests to (default usb0)
  UFI_ADMIN_USER      HIMI account name                  (default admin)

Exit codes: 0 complete · 2 usage · 3 device-not-present · 4 redaction sweep found something
EOF
}

# ── Redaction ────────────────────────────────────────────────────────────────────────
#
# Two layers, mirroring `control/src/redact.ts`: a KEY-based layer masking the value of a
# field whose name says what it holds, and a shape-based backstop for a long digit run
# wherever it appears. A subscriber identifier is 15 digits (IMEI, IMSI) or 19-20
# (ICCID); nothing in a USB descriptor is 14 digits long, so the backstop costs no
# descriptor fidelity. Interface numbers, class triples, `bcdDevice`, driver names and
# product strings all survive verbatim — they are the evidence.
redact_filter() {
	sed -E \
		-e "s/^([[:space:]]*iSerial[[:space:]]+[0-9]+[[:space:]]+).+$/\\1${MARKER}/" \
		-e "s/^(S:[[:space:]]*SerialNumber=).+$/\\1${MARKER}/" \
		-e "s/^((ID_SERIAL|ID_SERIAL_SHORT|ID_USB_SERIAL|ID_USB_SERIAL_SHORT|ID_SERIAL_ID|ID_NET_NAME_MAC)=).+$/\\1${MARKER}/" \
		-e "s/^([[:space:]]*(serial|serialnumber)[[:space:]]*[:=][[:space:]]*).+$/\\1${MARKER}/I" \
		-e "s/(\"[A-Za-z0-9_]*(serial|imei|imsi|iccid|msisdn|token|session|password|passwd)[A-Za-z0-9_]*\"[[:space:]]*:[[:space:]]*)\"[^\"]*\"/\\1\"${MARKER}\"/Ig" \
		-e "s/(\"(sn|esn|meid|simnumber|simid)\"[[:space:]]*:[[:space:]]*)\"[^\"]*\"/\\1\"${MARKER}\"/Ig" \
		-e "s/(\"[A-Za-z0-9_]*(serial|imei|imsi|iccid|msisdn|token|session|password|passwd)[A-Za-z0-9_]*\"[[:space:]]*:[[:space:]]*)[^\",}[:space:]]+/\\1\"${MARKER}\"/Ig" \
		-e "s/\\b(imei|imsi|iccid|msisdn|meid)\\b([[:space:]]*[:=][[:space:]]*)[A-Za-z0-9._-]+/\\1\\2${MARKER}/Ig" \
		-e "s/\\b([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\\b/${MARKER}/g" \
		-e "s/[0-9]{14,}/${MARKER}/g"
}

# The independent second check. It never prints the offending value — only the file, the
# line number and the fact that a rule fired — because a leak report quoting the leak IS
# the leak. `sweepUfiEvidenceText` in ufi-himi-evidence.ts is its tested twin; two
# checkers that disagree fail the capture, which is the direction to fail in.
sweep_file() {
	grep -nHE \
		-e '[0-9]{14,}' \
		-e 'iSerial[[:space:]]+[0-9]+[[:space:]]+[^[:space:][]' \
		-e 'SerialNumber=[^[:space:][]' \
		-e '(ID_SERIAL|ID_SERIAL_SHORT|ID_USB_SERIAL|ID_USB_SERIAL_SHORT|ID_SERIAL_ID|ID_NET_NAME_MAC)=[^[:space:][]' \
		-e '([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}' \
		-e '"[A-Za-z0-9_]*([Ss][Ee][Rr][Ii][Aa][Ll]|[Ii][Mm][EeSs][Ii]|[Ii][Cc][Cc][Ii][Dd]|[Mm][Ss][Ii][Ss][Dd][Nn])[A-Za-z0-9_]*"[[:space:]]*:[[:space:]]*"?[^"[:space:][]' \
		-- "$1" 2>/dev/null |
		cut -d: -f1,2 || true
}

sweep_path() {
	local target="$1" file hits findings=0
	if [ -d "$target" ]; then
		while IFS= read -r file; do
			hits="$(sweep_file "$file")"
			if [ -n "$hits" ]; then
				printf '%s\n' "$hits"
				findings=1
			fi
		done < <(find "$target" -type f | sort)
	else
		hits="$(sweep_file "$target")"
		if [ -n "$hits" ]; then
			printf '%s\n' "$hits"
			findings=1
		fi
	fi
	return "$findings"
}

# ── Presence ─────────────────────────────────────────────────────────────────────────
#
# Answered from sysfs, never from `lsusb`: the presence question must not depend on a
# package the bench image does not ship (docs/BENCH.md RB-9 records that `usbutils` is
# absent from it by default). A missing tool is a missing tool, not a missing device.
sys_devices() {
	local vendor="${USB_ID%%:*}" product="${USB_ID##*:}" dev
	for dev in /sys/bus/usb/devices/*; do
		if [ ! -r "$dev/idVendor" ] || [ ! -r "$dev/idProduct" ]; then continue; fi
		[ "$(cat "$dev/idVendor")" = "$vendor" ] || continue
		[ "$(cat "$dev/idProduct")" = "$product" ] || continue
		printf '%s\n' "$dev"
	done
}

read_attr() {
	cat "$1" 2>/dev/null || printf 'unreadable'
}

devices_json() {
	local dev separator='' out='['
	for dev in "${DEVICES[@]}"; do
		out="${out}${separator}\"$(basename "$dev")\""
		separator=','
	done
	printf '%s]' "$out"
}

# ── Capture steps ────────────────────────────────────────────────────────────────────
capture_sys_composition() {
	local dev intf
	for dev in "${DEVICES[@]}"; do
		printf '=== device %s ===\n' "$(basename "$dev")"
		printf 'idVendor=%s idProduct=%s bcdDevice=%s\n' \
			"$(read_attr "$dev/idVendor")" "$(read_attr "$dev/idProduct")" \
			"$(read_attr "$dev/bcdDevice")"
		printf 'bDeviceClass=%s bDeviceSubClass=%s bDeviceProtocol=%s bNumInterfaces=%s\n' \
			"$(read_attr "$dev/bDeviceClass")" "$(read_attr "$dev/bDeviceSubClass")" \
			"$(read_attr "$dev/bDeviceProtocol")" "$(read_attr "$dev/bNumInterfaces")"
		printf 'bNumConfigurations=%s bConfigurationValue=%s speed=%s\n' \
			"$(read_attr "$dev/bNumConfigurations")" \
			"$(read_attr "$dev/bConfigurationValue")" "$(read_attr "$dev/speed")"
		printf 'manufacturer=%s product=%s\n' \
			"$(read_attr "$dev/manufacturer")" "$(read_attr "$dev/product")"
		printf 'serial=%s\n' "$(read_attr "$dev/serial")"
		for intf in "$dev":*; do
			[ -d "$intf" ] || continue
			printf -- '--- interface %s ---\n' "$(basename "$intf")"
			printf 'bInterfaceNumber=%s bInterfaceClass=%s bInterfaceSubClass=%s bInterfaceProtocol=%s bNumEndpoints=%s\n' \
				"$(read_attr "$intf/bInterfaceNumber")" "$(read_attr "$intf/bInterfaceClass")" \
				"$(read_attr "$intf/bInterfaceSubClass")" \
				"$(read_attr "$intf/bInterfaceProtocol")" "$(read_attr "$intf/bNumEndpoints")"
			printf 'children=%s\n' \
				"$(find "$intf" -mindepth 1 -maxdepth 1 -printf '%f ' 2>/dev/null)"
		done
	done
}

# The binding is CAPTURED, never inferred. Which driver claims an interface is a fact
# about this kernel on this board, and it is the second half of every classification line
# in docs/UFI-DIAG-PROBE.md: the descriptor triple says what an interface IS, the binding
# says who took it. Upstream matching an id in a driver table is not evidence about THIS
# unit, which is why the two halves are recorded separately and never merged.
capture_driver_bindings() {
	local dev intf driver
	for dev in "${DEVICES[@]}"; do
		for intf in "$dev":*; do
			[ -d "$intf" ] || continue
			driver='unbound'
			[ -L "$intf/driver" ] && driver="$(basename "$(readlink -f "$intf/driver")")"
			printf '%s class=%s subclass=%s protocol=%s driver=%s\n' \
				"$(basename "$intf")" "$(read_attr "$intf/bInterfaceClass")" \
				"$(read_attr "$intf/bInterfaceSubClass")" \
				"$(read_attr "$intf/bInterfaceProtocol")" "$driver"
		done
	done
}

capture_udev_properties() {
	local dev intf
	for dev in "${DEVICES[@]}"; do
		printf '=== device %s ===\n' "$(basename "$dev")"
		udevadm info -q property -p "$dev" 2>/dev/null || printf 'udevadm-query-failed\n'
		for intf in "$dev":*; do
			[ -d "$intf" ] || continue
			printf -- '--- interface %s ---\n' "$(basename "$intf")"
			udevadm info -q property -p "$intf" 2>/dev/null || printf 'udevadm-query-failed\n'
		done
	done
}

# The HIMI half. Only the frozen vocabulary the shipped provider is itself limited to:
# one `login` to open a session, then two `get*` reads. A `SessionOut` reply ends the
# step — the login is never retried in a loop.
himi_post() {
	curl --silent --show-error --max-time 10 --no-location \
		--interface "$HIMI_INTERFACE" \
		--header 'Content-Type: application/json;charset=UTF-8' \
		"$@" \
		"${HIMI_URL}/himiapi/json"
}

capture_himi_identity() {
	local login_reply session produce sysinfo
	login_reply="$(himi_post --data \
		"{\"cmdid\":\"login\",\"username\":\"${HIMI_USER}\",\"password\":\"${UFI_BENCH_PASSWORD}\"}")" ||
		return 1
	case "$login_reply" in
	*SessionOut*) return 1 ;;
	esac
	session="$(printf '%s' "$login_reply" | jq -er '.session // .sessionid // .token // empty')" || return 1
	produce="$(himi_post --header "Authorization: ${session}" --data '{"cmdid":"getproduceinfo"}')" || return 1
	sysinfo="$(himi_post --header "Authorization: ${session}" --data '{"cmdid":"getsysinfo"}')" || return 1
	# The login reply is deliberately NOT written: it carries the session material, and a
	# bundle is a thing that gets pasted into a review comment.
	printf '{"getproduceinfo":%s,"getsysinfo":%s}\n' "$produce" "$sysinfo" | jq -S .
}

main_capture() {
	local out_dir staging stamp findings
	local lsusb_status='captured' usb_devices_status='captured'
	local udev_status='captured' himi_status='skipped-no-credential'
	stamp="$(date -u +%Y%m%dT%H%M%SZ)"
	out_dir="${UFI_CAPTURE_DIR:-test-results/ufi-himi-descriptor/${USB_ID//:/-}-${stamp}}"

	mapfile -t DEVICES < <(sys_devices)
	if [ "${#DEVICES[@]}" -eq 0 ]; then
		printf '%s\n' 'device-not-present'
		printf 'no USB device matching %s is attached; no bundle was written\n' "$USB_ID" >&2
		exit 3
	fi

	# Staged, then moved into place as a unit. A capture that dies halfway leaves the
	# staging directory behind and NOTHING at the published path, so a partial bundle can
	# never be mistaken for a complete one.
	staging="$(mktemp -d)"
	chmod 700 "$staging"
	trap 'rm -rf "$staging"' EXIT

	if command -v lsusb >/dev/null 2>&1; then
		lsusb -v -d "${USB_ID%%:*}:" 2>/dev/null | redact_filter >"$staging/lsusb-verbose.txt" || true
		[ -s "$staging/lsusb-verbose.txt" ] || lsusb_status='empty'
	else
		lsusb_status='tool-unavailable'
		printf 'lsusb-unavailable\n' >"$staging/lsusb-verbose.txt"
	fi

	if command -v usb-devices >/dev/null 2>&1; then
		usb-devices 2>/dev/null | redact_filter >"$staging/usb-devices.txt" || true
		[ -s "$staging/usb-devices.txt" ] || usb_devices_status='empty'
	else
		usb_devices_status='tool-unavailable'
		printf 'usb-devices-unavailable\n' >"$staging/usb-devices.txt"
	fi

	if command -v udevadm >/dev/null 2>&1; then
		capture_udev_properties | redact_filter >"$staging/udev-properties.txt"
	else
		udev_status='tool-unavailable'
		printf 'udevadm-unavailable\n' >"$staging/udev-properties.txt"
	fi

	capture_driver_bindings | redact_filter >"$staging/driver-bindings.txt"
	capture_sys_composition | redact_filter >"$staging/sys-composition.txt"

	if [ -n "${UFI_BENCH_PASSWORD:-}" ]; then
		if ! command -v jq >/dev/null 2>&1; then
			himi_status='tool-unavailable'
		elif capture_himi_identity | redact_filter >"$staging/himi-identity.json"; then
			himi_status='captured'
		else
			himi_status='unreachable'
			rm -f "$staging/himi-identity.json"
		fi
	fi

	cat >"$staging/manifest.json" <<EOF
{
  "schemaVersion": ${SCHEMA_VERSION},
  "kind": "ufi-himi-descriptor-evidence",
  "usbId": "${USB_ID}",
  "capturedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "host": "$(uname -n)",
  "kernel": "$(uname -r)",
  "matchedSysfsDevices": $(devices_json),
  "steps": {
    "lsusbVerbose": "${lsusb_status}",
    "usbDevices": "${usb_devices_status}",
    "udevProperties": "${udev_status}",
    "driverBindings": "captured",
    "sysComposition": "captured",
    "himiIdentity": "${himi_status}"
  },
  "redaction": "capture-time",
  "mutations": "none"
}
EOF

	# Fail CLOSED: a surviving identifier destroys the staging directory rather than
	# publishing it, and there is no flag to override that.
	if ! findings="$(sweep_path "$staging")"; then
		printf '%s\n' 'redaction-sweep-failed' >&2
		printf '%s\n' "$findings" | sed "s#^${staging}/##" >&2
		exit 4
	fi

	mkdir -p "$(dirname "$out_dir")"
	mv "$staging" "$out_dir"
	chmod 755 "$out_dir"
	trap - EXIT
	printf '%s\n' 'capture-complete'
	printf '%s\n' "$out_dir"
}

case "${1:-}" in
--help | -h)
	usage
	;;
--redact-filter)
	redact_filter
	;;
--sweep)
	if [ -z "${2:-}" ]; then
		printf 'usage: ufi-himi-capture.sh --sweep <path>\n' >&2
		exit 2
	fi
	if sweep_path "$2"; then
		printf '%s\n' 'sweep-clean'
	else
		printf '%s\n' 'sweep-findings' >&2
		exit 4
	fi
	;;
'')
	main_capture
	;;
*)
	printf 'unknown argument: %s\n' "$1" >&2
	exit 2
	;;
esac
