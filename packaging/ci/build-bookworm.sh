#!/usr/bin/env bash
# build-bookworm.sh <amd64|arm64> — differential ModemManager-stack rebuild for bookworm.
#
# BUILD SET
#   BUILD_SOURCES may be an explicitly set space/comma-separated list of upstream-pins.yaml
#   pin keys: libqrtr-glib libmbim libqmi modemmanager. An explicitly empty value selects zero
#   sources. Alternatively, VERDICTS_FILE may point directly at detect-changed-sources.sh's
#   five-line `<pin-key>=changed|unchanged` + `mode=` output. Supplying neither preserves the
#   local-development default and builds all four sources. Supplying both fails closed.
#
# DIFFERENTIAL INVARIANT
#   Selected sources build in the mandatory bootstrap order. Before the first build, every deb
#   belonging to each skipped source is copied from the already-staged output directory into the
#   temporary Pin-Priority 1001 local apt repo. A selected source therefore resolves stack
#   build-deps and gir typelibs against carried CeraLive packages, never stock bookworm merely
#   because its dependency source was skipped.
#
# OUTPUT + ASSERTIONS
#   Carried .debs already staged by stage-carryforward-debs.sh are preserved. Only stale
#   *.changes/*.buildinfo and artifacts belonging to sources selected for this run are removed.
#   Freshly built sources retain the existing exact check-package-sets.sh verification from their
#   .changes. The full runtime closure is asserted from the MERGED staged deb set (built + carried)
#   at the end. A zero-source run starts no container and still performs that merged assertion.
#
# VERSIONING
#   Release builds invoke inject-deb-version.sh once per selected source. It consumes the caller's
#   already-resolved PREV_MANIFEST_FILE and derives that source's next ~ceralive.N counter; this
#   script never fetches the previous manifest. Dev builds retain ~ceralive0.0.0~dev.
#
# TEST SEAM
#   BUILD_BOOKWORM_STUB_DIR is used only by test-build-bookworm-differential.sh. It replaces the
#   expensive build body with source-keyed fixture artifacts while exercising production build-set
#   parsing, seeding, dispatch, check-package-sets.sh, and merged-closure logic.
#
# EXIT
#   0 success. 2 usage/environment. 3 fail-closed package/carry/closure drift. Other non-zero is a
#   real tooling or source-build failure.
set -euo pipefail

BUILD_ORDER=(libqrtr-glib libmbim libqmi ModemManager)
EXPECTED_RUNTIME=(libmbim-glib4 libmbim-proxy libmbim-utils libmm-glib0 libqmi-glib5 \
	libqmi-proxy libqmi-utils libqrtr-glib0 modemmanager)

LOG_PREFIX="build-bookworm"
build_log() { printf '%s: %s\n' "$LOG_PREFIX" "$*" >&2; }
die() {
	printf '%s: %s\n' "$LOG_PREFIX" "$*" >&2
	exit 2
}
refuse() {
	printf '%s: FAIL CLOSED — %s\n' "$LOG_PREFIX" "$*" >&2
	exit 3
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PKG_ROOT="$(cd "$HERE/.." && pwd)"

# Map a packaging directory name to its upstream-pins.yaml source key. Only ModemManager differs.
pin_key() { case "$1" in ModemManager) echo modemmanager ;; *) echo "$1" ;; esac; }

is_known_key() {
	local wanted="$1" dir
	for dir in "${BUILD_ORDER[@]}"; do
		[ "$(pin_key "$dir")" = "$wanted" ] && return 0
	done
	return 1
}

expected_source_set() { # <source-key> <expected-packages-file>
	awk -v want="[$1 all-artifact]" '
		/^\[/ { h=$0; sub(/[ \t]*#.*$/, "", h); insec=(h==want)?1:0; next }
		insec { l=$0; sub(/#.*$/, "", l); gsub(/[ \t]+/, "", l); if (l!="") print l }
	' "$2" | LC_ALL=C sort -u
}

declare -A SELECTED=()
BUILD_DIRS=()
BUILD_SOURCE_KEYS=()

select_key() {
	local key="$1"
	is_known_key "$key" || die "unknown build source '$key' (expected pin-key names: libqrtr-glib libmbim libqmi modemmanager)"
	[ -z "${SELECTED[$key]:-}" ] || die "build source '$key' was selected more than once"
	SELECTED["$key"]=1
}

resolve_verdicts_file() { # <path>
	local verdicts_file="$1" line key value mode="" dir
	local -A verdict=()

	[ -r "$verdicts_file" ] || die "VERDICTS_FILE='$verdicts_file' is set but not readable"
	while IFS= read -r line || [ -n "$line" ]; do
		[ -n "$line" ] || continue
		case "$line" in
		\#*) continue ;;
		mode=*)
			[ -z "$mode" ] || die "VERDICTS_FILE='$verdicts_file' contains more than one mode= line"
			mode="${line#mode=}"
			;;
		*=changed | *=unchanged)
			key="${line%%=*}"
			value="${line#*=}"
			is_known_key "$key" || die "VERDICTS_FILE='$verdicts_file' names unknown source '$key'"
			[ -z "${verdict[$key]:-}" ] || die "VERDICTS_FILE='$verdicts_file' verdicts source '$key' more than once"
			verdict["$key"]="$value"
			;;
		*) die "VERDICTS_FILE='$verdicts_file' has unparseable line '$line'" ;;
		esac
	done <"$verdicts_file"

	case "$mode" in
	differential | force-all) ;;
	"") die "VERDICTS_FILE='$verdicts_file' contains no mode= line" ;;
	*) die "VERDICTS_FILE='$verdicts_file' has unrecognized mode '$mode'" ;;
	esac

	for dir in "${BUILD_ORDER[@]}"; do
		key="$(pin_key "$dir")"
		[ -n "${verdict[$key]:-}" ] || die "VERDICTS_FILE='$verdicts_file' contains no verdict for source '$key'"
		if [ "$mode" = force-all ] && [ "${verdict[$key]}" != changed ]; then
			die "VERDICTS_FILE='$verdicts_file' says mode=force-all but source '$key' is '${verdict[$key]}'"
		fi
		if [ "${verdict[$key]}" = changed ]; then select_key "$key"; fi
	done
	build_log "build set read from VERDICTS_FILE='$verdicts_file' (mode=$mode)"
}

resolve_build_set() {
	local normalized token dir key
	local requested=()

	if [ -n "${VERDICTS_FILE:-}" ] && [ "${BUILD_SOURCES+x}" = x ]; then
		die "BUILD_SOURCES and VERDICTS_FILE are mutually exclusive; pass one build-set contract"
	fi

	if [ -n "${VERDICTS_FILE:-}" ]; then
		resolve_verdicts_file "$VERDICTS_FILE"
	elif [ "${BUILD_SOURCES+x}" = x ]; then
		normalized="${BUILD_SOURCES//,/ }"
		if [[ "$normalized" =~ [^[:space:]] ]]; then
			read -r -a requested <<<"$normalized"
		fi
		for token in "${requested[@]}"; do select_key "$token"; done
		build_log "build set read from BUILD_SOURCES='${BUILD_SOURCES}'"
	else
		for dir in "${BUILD_ORDER[@]}"; do select_key "$(pin_key "$dir")"; done
		build_log "no build-set input supplied; defaulting to all sources"
	fi

	for dir in "${BUILD_ORDER[@]}"; do
		key="$(pin_key "$dir")"
		if [ -n "${SELECTED[$key]:-}" ]; then
			BUILD_DIRS+=("$dir")
			BUILD_SOURCE_KEYS+=("$key")
		fi
	done
}

is_selected() { [ -n "${SELECTED[$1]:-}" ]; }

assert_merged_runtime_closure() { # <staged-arch-dir>
	local staged_dir="$1" deb filename package expected got
	local debs=() runtime=() runtime_sorted=()
	local -A seen=()

	shopt -s nullglob
	debs=("$staged_dir"/*.deb)
	shopt -u nullglob
	for deb in "${debs[@]}"; do
		filename="$(basename "$deb")"
		case "$filename" in
		*_*.deb) package="${filename%%_*}" ;;
		*) refuse "merged staged file '$filename' is not a canonical '<package>_<version>_<arch>.deb' name" ;;
		esac
		case "$package" in
		*-dev | *-doc | *-dbgsym | gir1.2-*) continue ;;
		esac
		if [ -n "${seen[$package]:-}" ]; then
			refuse "merged runtime set contains more than one staged deb for package '$package' ('$filename' and '${seen[$package]}')"
		fi
		seen["$package"]="$filename"
		runtime+=("$package")
	done

	if [ "${#runtime[@]}" -gt 0 ]; then
		mapfile -t runtime_sorted < <(printf '%s\n' "${runtime[@]}" | LC_ALL=C sort -u)
	fi
	expected="$(printf '%s\n' "${EXPECTED_RUNTIME[@]}" | LC_ALL=C sort -u)"
	got="$(printf '%s\n' "${runtime_sorted[@]:-}" | sed '/^$/d')"

	if [ "$expected" != "$got" ]; then
		printf '%s: FAIL CLOSED — merged runtime closure drift in %s\n' "$LOG_PREFIX" "$staged_dir" >&2
		comm -23 <(printf '%s\n' "$expected") <(printf '%s\n' "$got") \
			| sed 's/^/  MISSING (expected, not staged): /' >&2 || true
		comm -13 <(printf '%s\n' "$expected") <(printf '%s\n' "$got") \
			| sed 's/^/  UNEXPECTED (staged, not expected): /' >&2 || true
		exit 3
	fi
	build_log "MERGED RUNTIME CLOSURE OK: ${#EXPECTED_RUNTIME[@]} expected packages across built + carried debs in '$staged_dir'"
}

clean_run_outputs() { # <out-dir> <expected-packages-file>
	local out_dir="$1" expected_file="$2" key package source_set
	rm -f "$out_dir"/*.changes "$out_dir"/*.buildinfo 2>/dev/null || true
	for key in "${BUILD_SOURCE_KEYS[@]}"; do
		source_set="$(expected_source_set "$key" "$expected_file")"
		[ -n "$source_set" ] || die "source '$key' has no [$key all-artifact] block in '$expected_file'"
		while IFS= read -r package; do
			[ -n "$package" ] || continue
			rm -f "$out_dir/${package}_"*.deb
		done <<<"$source_set"
		build_log "cleared stale artifacts for selected source '$key'; carried debs for skipped sources were preserved"
	done
}

resolve_build_set
CANONICAL_BUILD_SOURCES="${BUILD_SOURCE_KEYS[*]}"

# ==========================================================================================
# HOST ROLE — preserve staged carries, launch selected builds, or prove a zero-build closure.
# ==========================================================================================
if [ "${BUILD_IN_CONTAINER:-0}" != 1 ]; then
	ARCH="${1:-}"
	case "$ARCH" in
	amd64) PLATFORM="linux/amd64" ;;
	arm64) PLATFORM="linux/arm64" ;;
	*) echo "usage: build-bookworm.sh <amd64|arm64>" >&2; exit 2 ;;
	esac

	PKG_ROOT="$SCRIPT_PKG_ROOT"
	OUT="${OUT:-$PKG_ROOT/build/$ARCH}"
	mkdir -p "$OUT"
	clean_run_outputs "$OUT" "$PKG_ROOT/ci/expected-packages.txt"

	build_log "arch=$ARCH platform=$PLATFORM"
	build_log "packaging root=$PKG_ROOT"
	build_log "output=$OUT"
	build_log "selected sources (${#BUILD_SOURCE_KEYS[@]}): ${CANONICAL_BUILD_SOURCES:-none}"

	if [ "${#BUILD_SOURCE_KEYS[@]}" -eq 0 ]; then
		build_log "zero-build path: no source selected; no container will be started"
		assert_merged_runtime_closure "$OUT"
		build_log "PASS [$ARCH]: zero sources built; carried-only merged runtime closure is complete"
		exit 0
	fi

	command -v docker >/dev/null 2>&1 || die "docker not found"
	if [ -n "${PREV_MANIFEST_FILE:-}" ] && [ ! -r "$PREV_MANIFEST_FILE" ]; then
		die "PREV_MANIFEST_FILE='$PREV_MANIFEST_FILE' is set but not readable"
	fi
	if [ -n "${RELEASE_VERSION:-}" ] && [ -z "${PREV_MANIFEST_FILE:-}" ] &&
		[ "${#BUILD_SOURCE_KEYS[@]}" -ne "${#BUILD_ORDER[@]}" ]; then
		die "release differential build selects ${#BUILD_SOURCE_KEYS[@]} source(s) but PREV_MANIFEST_FILE is absent; only a force-all bootstrap may initialize counters without a previous manifest"
	fi

	docker_args=(
		run --rm --platform "$PLATFORM"
		-e BUILD_IN_CONTAINER=1
		-e ARCH="$ARCH"
		-e BUILD_SOURCES="$CANONICAL_BUILD_SOURCES"
		-e RELEASE_VERSION="${RELEASE_VERSION:-}"
	)
	if [ -n "${PREV_MANIFEST_FILE:-}" ]; then
		docker_args+=(
			-e PREV_MANIFEST_FILE=/previous-release-manifest.txt
			-v "$PREV_MANIFEST_FILE":/previous-release-manifest.txt:ro
		)
	fi
	docker_args+=(
		-v "$PKG_ROOT":/pkg:ro
		-v "$OUT":/out
		debian:bookworm
		bash /pkg/ci/build-bookworm.sh "$ARCH"
	)
	docker "${docker_args[@]}"

	build_log "container finished; merged artifacts are in '$OUT'"
	exit 0
fi

# ==========================================================================================
# CONTAINER ROLE — seed skipped sources, then build only selected sources in bootstrap order.
# ==========================================================================================
PKG_MOUNT="${BUILD_BOOKWORM_PKG_ROOT:-/pkg}"
OUT_DIR="${BUILD_BOOKWORM_OUT_DIR:-/out}"
STUB_BUILD_DIR="${BUILD_BOOKWORM_STUB_DIR:-}"
[ -d "$PKG_MOUNT" ] || die "container packaging root '$PKG_MOUNT' is not a directory"
[ -d "$OUT_DIR" ] || die "container output '$OUT_DIR' is not a directory"
if [ -n "$STUB_BUILD_DIR" ] && [ ! -d "$STUB_BUILD_DIR" ]; then
	die "BUILD_BOOKWORM_STUB_DIR='$STUB_BUILD_DIR' is set but not a directory"
fi

ARCH="${ARCH:-}"
if [ -z "$ARCH" ]; then
	[ -z "$STUB_BUILD_DIR" ] || die "ARCH is required with BUILD_BOOKWORM_STUB_DIR"
	ARCH="$(dpkg --print-architecture)"
fi

log()  { echo "  [build] $*"; }
step() { echo; echo "==== $* ===="; }

if [ "${#BUILD_SOURCE_KEYS[@]}" -eq 0 ]; then
	build_log "zero-build container role: no source selected; skipping all tooling and build setup"
	assert_merged_runtime_closure "$OUT_DIR"
	exit 0
fi

if [ -n "$STUB_BUILD_DIR" ]; then
	echo "== stubbed in-container build (target=$ARCH) =="
	log "BUILD_BOOKWORM_STUB_DIR active: real apt and dpkg-buildpackage commands are disabled"
else
	echo "== in-container build (arch=$(dpkg --print-architecture), target=$ARCH, $(uname -m)) =="
fi

export DEBIAN_FRONTEND=noninteractive
if [ -n "$STUB_BUILD_DIR" ]; then
	NPROC=1
else
	NPROC="$(nproc)"
fi
export DEB_BUILD_OPTIONS="nocheck nodoc parallel=$NPROC"
export DEBEMAIL="ci@ceralive.tv"
export DEBFULLNAME="CeraLive CI"

if [ -z "$STUB_BUILD_DIR" ]; then
	# apt drops to `_apt`, which cannot read a file: repo under mktemp's 0700 directory.
	echo 'APT::Sandbox::User "root";' > /etc/apt/apt.conf.d/01-no-sandbox
	step "install build tooling"
	apt-get update -qq
	apt-get install -y -qq --no-install-recommends \
		build-essential dpkg-dev devscripts equivs \
		meson ninja-build pkgconf ca-certificates curl xz-utils bzip2 >/dev/null
	DPKGBP_VER="$(dpkg-buildpackage --version 2>/dev/null | sed -n '1p' || true)"
	log "toolchain ready: $DPKGBP_VER"
else
	step "install build tooling (stubbed)"
	log "toolchain stub ready"
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/mmbuild.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
PKGW="$WORK/pkg"
cp -a "$PKG_MOUNT" "$PKGW"
REPO="$WORK/repo"
mkdir -p "$REPO"
: >"$REPO/Packages"

if [ -z "$STUB_BUILD_DIR" ]; then
	echo "deb [trusted=yes] file:$REPO ./" > /etc/apt/sources.list.d/local-mm.list
	cat > /etc/apt/preferences.d/local-mm.pref <<'EOF'
Package: *
Pin: origin ""
Pin-Priority: 1001
EOF
	apt-get update -qq
fi

refresh_repo() {
	if [ -n "$STUB_BUILD_DIR" ]; then
		find "$REPO" -maxdepth 1 -type f -name '*.deb' -printf '%f\n' | LC_ALL=C sort >"$REPO/Packages"
	else
		(cd "$REPO" && dpkg-scanpackages -m . /dev/null >Packages 2>/dev/null)
		apt-get update -qq
	fi
}

seed_carried_source() { # <source-key>
	local source_name="$1" package source_set count=0
	local matches=()
	source_set="$(expected_source_set "$source_name" "$PKGW/ci/expected-packages.txt")"
	[ -n "$source_set" ] || die "source '$source_name' has no [$source_name all-artifact] block in '$PKGW/ci/expected-packages.txt'"

	while IFS= read -r package; do
		[ -n "$package" ] || continue
		shopt -s nullglob
		matches=("$OUT_DIR/${package}_"*.deb)
		shopt -u nullglob
		if [ "${#matches[@]}" -eq 0 ]; then
			refuse "skipped source '$source_name' carried package '$package' is missing from '$OUT_DIR'; build-deps must never fall back to stock bookworm"
		fi
		if [ "${#matches[@]}" -gt 1 ]; then
			refuse "skipped source '$source_name' carried package '$package' has ${#matches[@]} staged debs in '$OUT_DIR'; the local repo seed requires exactly one version"
		fi
		cp "${matches[0]}" "$REPO/"
		count=$((count + 1))
	done <<<"$source_set"
	log "seed $source_name: copied $count carried deb(s) into the local apt repo"
}

step "seed local apt repo with carried debs for skipped sources"
seeded_sources=0
for dir in "${BUILD_ORDER[@]}"; do
	key="$(pin_key "$dir")"
	if ! is_selected "$key"; then
		seed_carried_source "$key"
		seeded_sources=$((seeded_sources + 1))
	fi
done
if [ "$seeded_sources" -gt 0 ]; then
	refresh_repo
	log "carried-deb seed complete before first BUILD; Pin-Priority 1001 local repo contains every skipped source"
else
	log "no skipped source; local apt repo starts empty and will be populated in bootstrap order"
fi

INJECT_ARG="${RELEASE_VERSION:-}"
[ -n "$INJECT_ARG" ] || INJECT_ARG="--dev"
for dir in "${BUILD_DIRS[@]}"; do
	key="$(pin_key "$dir")"
	step "inject version for $key ($INJECT_ARG)"
	(cd "$PKGW" && bash ci/inject-deb-version.sh --source "$key" "$INJECT_ARG")
done

pin_scalar() {
	awk -v src="$1" -v key="$2" '
		$0 ~ "^  " src ":[ \t]*$" { inblk=1; next }
		inblk && /^  [^ ]/ { inblk=0 }
		inblk && /^[^ ]/   { inblk=0 }
		inblk && $0 ~ "^    " key ":" {
			v=$0; sub("^    " key ":[ \t]*", "", v); gsub(/^"|"$/, "", v); print v; exit
		}
	' "$PKGW/upstream-pins.yaml"
}

build_one() {
	local dir="$1" key
	key="$(pin_key "$dir")"
	step "BUILD $dir  (pin key: $key)"

	if [ -n "$STUB_BUILD_DIR" ]; then
		local fixture="$STUB_BUILD_DIR/$key" file
		local fixture_debs=() fixture_changes=() fixture_buildinfo=()
		[ -d "$fixture" ] || die "stub build for source '$key' has no fixture directory '$fixture'"
		shopt -s nullglob
		fixture_debs=("$fixture"/*.deb)
		fixture_changes=("$fixture"/*.changes)
		fixture_buildinfo=("$fixture"/*.buildinfo)
		shopt -u nullglob
		[ "${#fixture_debs[@]}" -gt 0 ] || die "stub build for source '$key' contains no .deb"
		[ "${#fixture_changes[@]}" -gt 0 ] || die "stub build for source '$key' contains no .changes"
		for file in "${fixture_debs[@]}"; do cp "$file" "$OUT_DIR/"; cp "$file" "$REPO/"; done
		for file in "${fixture_changes[@]}"; do cp "$file" "$OUT_DIR/"; done
		for file in "${fixture_buildinfo[@]}"; do cp "$file" "$OUT_DIR/"; done
		refresh_repo
		log "$dir stub-built; fixture artifacts entered output + local repo"
		return 0
	fi

	local src ver upstream
	src="$(dpkg-parsechangelog -l "$PKGW/$dir/debian/changelog" -S Source)"
	ver="$(dpkg-parsechangelog -l "$PKGW/$dir/debian/changelog" -S Version)"
	upstream="${ver%%-*}"
	log "source=$src version=$ver upstream=$upstream"

	local url name sha
	url="$(pin_scalar "$key" orig_tar_url)"
	name="$(pin_scalar "$key" orig_tar_name)"
	sha="$(pin_scalar "$key" orig_tar_sha256)"
	if [ -z "$url" ] || [ -z "$name" ] || [ -z "$sha" ]; then
		die "missing pin for source '$key'"
	fi
	log "orig: $name"
	curl -fsSL --retry 3 --retry-delay 2 -o "$WORK/$name" "$url"
	local got
	got="$(sha256sum "$WORK/$name" | awk '{print $1}')"
	[ "$got" = "$sha" ] || refuse "orig sha256 drift for '$name' (source '$key': pin $sha, got $got)"
	log "orig sha256 OK ($sha)"

	local bdir="$WORK/build"
	mkdir -p "$bdir"
	local tree="$bdir/${src}-${upstream}"
	rm -rf "$tree"
	mkdir -p "$tree"
	tar -xf "$WORK/$name" -C "$tree" --strip-components=1
	cp -a "$PKGW/$dir/debian" "$tree/debian"
	cp "$WORK/$name" "$bdir/${src}_${upstream}.orig.${name#*.orig.}"

	log "apt-get build-dep (Pin-Priority 1001 local repo supplies built + carried stack deps)"
	apt-get build-dep -y --no-install-recommends "$tree" >/dev/null

	local gir_names
	gir_names="$(find "$REPO" -maxdepth 1 -name 'gir1.2-*.deb' -printf '%f\n' 2>/dev/null \
		| sed 's/_.*//' | sort -u | tr '\n' ' ')"
	if [ -n "${gir_names// /}" ]; then
		log "install local gir typelibs so dh_girepository resolves them: $gir_names"
		# shellcheck disable=SC2086  # package names are intentionally split for apt-get argv
		apt-get install -y --no-install-recommends $gir_names >/dev/null
	fi

	log "dpkg-buildpackage -B (DEB_BUILD_OPTIONS='$DEB_BUILD_OPTIONS')"
	(cd "$tree" && dpkg-buildpackage -B -us -uc)

	find "$bdir" -maxdepth 1 -name '*.changes' -exec cp -t "$OUT_DIR" {} + 2>/dev/null || true
	find "$bdir" -maxdepth 1 -name '*.buildinfo' -exec cp -t "$OUT_DIR" {} + 2>/dev/null || true
	find "$bdir" -maxdepth 1 -name '*.deb' -exec cp -t "$OUT_DIR" {} + 2>/dev/null || true
	find "$bdir" -maxdepth 1 -name '*.deb' -exec mv -t "$REPO" {} + 2>/dev/null || true

	refresh_repo
	local repo_debs=()
	shopt -s nullglob
	repo_debs=("$REPO"/*.deb)
	shopt -u nullglob
	log "$dir built; local repo now has ${#repo_debs[@]} .deb(s)"
}

for dir in "${BUILD_DIRS[@]}"; do build_one "$dir"; done

step "fresh-source package-set equality (selected sources only, from *.changes)"
bash "$PKGW/ci/check-package-sets.sh" "$OUT_DIR" "$PKGW/ci/expected-packages.txt"

step "merged runtime closure verification (freshly built + carried debs)"
assert_merged_runtime_closure "$OUT_DIR"

echo
echo "PASS [$ARCH]: ${#BUILD_SOURCE_KEYS[@]} selected source(s) built in bootstrap order; skipped-source debs seeded before BUILD; merged runtime closure complete."
