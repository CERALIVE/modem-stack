#!/usr/bin/env bash
# verify-upstream-pins.sh — re-verify every field in packaging/upstream-pins.yaml.
#
# Proves the provenance chain for the four ModemManager-stack sources CeraLive rebuilds:
#
#   1. LINEAGE   — `git ls-remote --tags <upstream_repo> <upstream_tag>` still resolves to
#                  the pinned tag-object SHA and peeled commit SHA (and the same for the
#                  salsa packaging tag). The git tag authenticates *which commit* the release
#                  names; it is never byte-compared to a git archive.
#   2. AUTHORITY — the signed Debian `.dsc`'s GPG clearsign verifies against the pinned
#                  `signer_fingerprint`, whose armored key lives in packaging/keys/. A verified
#                  `.dsc` is the authority for the tarball checksums it embeds.
#   3. ARTIFACT  — the `.orig.tar` downloads and its sha256 equals `orig_tar_sha256`, which
#                  equals the matching line in the `.dsc`'s Checksums-Sha256 (copied verbatim
#                  into the manifest's `dsc_checksums_sha256`).
#   4. PACKAGING — the `.debian.tar.xz` downloads (from `debian_tar_url`), its sha256 equals
#                  `debian_tar_sha256` (which equals its line in the verified `.dsc`, so the
#                  .dsc stays the checksum authority), and its extracted `debian/` tree is
#                  proven byte-identical to the pinned salsa tag's `debian/` tree via a
#                  CANONICAL TREE MANIFEST (per entry: relative path, file type, executable
#                  bit, symlink target, content sha256). Stronger than `diff -r` — it also
#                  catches exec-bit and symlink-target drift. Chain closed.
#
# ALL GPG work happens in a throwaway isolated GNUPGHOME (mktemp -d, 0700, rm -rf on exit).
# The caller's ~/.gnupg is never touched or read.
#
# Exit status:
#   0  every field of every checked source verified.
#   1  a verification failure — a single line `FAIL [<source>] <field>: <detail>` on stderr
#      names exactly which field failed (fail-closed).
#   2  usage / environment error (missing tool, unreadable manifest).
#
# Usage:
#   verify-upstream-pins.sh [OPTIONS] [MANIFEST]
#     MANIFEST            path to the pin manifest (default: <script>/../upstream-pins.yaml)
#     --source NAME       verify only this one source (default: all sources in the manifest)
#     --no-lineage        skip the git ls-remote lineage re-checks (offline mode). Used by the
#                         negative-fixture tests, which tamper with .dsc/.orig data, not git
#                         lineage, and must run without network. The real acceptance run omits
#                         this flag and performs the full network verification.
#     --keys-base DIR     resolve each source's `signer_key_file` relative to DIR
#                         (default: the manifest's own directory, so `keys/<fpr>.asc` -> packaging/keys/).
#
# URL scheme in the manifest:
#   http(s)://…   fetched with curl (real run).
#   local:REL     read from REL resolved relative to the manifest's directory (fixtures — no network).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---- options -------------------------------------------------------------------------------
MANIFEST=""
ONLY_SOURCE=""
DO_LINEAGE=1
KEYS_BASE=""
while [ $# -gt 0 ]; do
	case "$1" in
		--source)     ONLY_SOURCE="${2-}"; shift 2 ;;
		--no-lineage) DO_LINEAGE=0; shift ;;
		--keys-base)  KEYS_BASE="${2-}"; shift 2 ;;
		-h|--help)    sed -n '2,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
		-*)           echo "verify-upstream-pins: unknown option '$1'" >&2; exit 2 ;;
		*)            MANIFEST="$1"; shift ;;
	esac
done
[ -n "$MANIFEST" ] || MANIFEST="$HERE/../upstream-pins.yaml"
[ -r "$MANIFEST" ] || { echo "verify-upstream-pins: cannot read manifest '$MANIFEST'" >&2; exit 2; }
MANIFEST="$(cd "$(dirname "$MANIFEST")" && pwd)/$(basename "$MANIFEST")"
MANIFEST_DIR="$(dirname "$MANIFEST")"
[ -n "$KEYS_BASE" ] || KEYS_BASE="$MANIFEST_DIR"

for tool in gpg curl sha256sum awk git tar; do
	command -v "$tool" >/dev/null 2>&1 || { echo "verify-upstream-pins: missing required tool '$tool'" >&2; exit 2; }
done

# ---- isolated GNUPGHOME (never the caller's ~/.gnupg) --------------------------------------
GNUPGHOME="$(mktemp -d "${TMPDIR:-/tmp}/pins-gnupg.XXXXXX")"
export GNUPGHOME
chmod 700 "$GNUPGHOME"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/pins-work.XXXXXX")"
cleanup() { rm -rf "$GNUPGHOME" "$WORKDIR"; }
trap cleanup EXIT
# Keep gpg quiet and non-interactive; no dirmngr / network keyservers here.
GPG=(gpg --homedir "$GNUPGHOME" --batch --no-tty --quiet --no-auto-key-retrieve --keyid-format long)

# ---- tiny dependency-free YAML readers (tailored to this manifest's fixed shape) -----------
# Scalar field of a source:  sources.<src>.<field>  ->  unquoted value.
yaml_scalar() {
	awk -v src="$1" -v key="$2" '
		$0 ~ "^  " src ":[ \t]*$" { inblk=1; next }
		inblk && /^  [^ ]/ { inblk=0 }
		inblk && /^[^ ]/   { inblk=0 }
		inblk && $0 ~ "^    " key ":" {
			v=$0; sub("^    " key ":[ \t]*", "", v); gsub(/^"|"$/, "", v); print v; exit
		}
	' "$MANIFEST"
}
# Block-literal field:  sources.<src>.<field>: |  ->  its 6-space-indented lines, dedented.
yaml_block() {
	awk -v src="$1" -v key="$2" '
		$0 ~ "^  " src ":[ \t]*$" { inblk=1; next }
		inblk && incontent && /^      / { s=$0; sub(/^      /, "", s); print s; next }
		inblk && incontent && !/^      / { incontent=0 }
		inblk && /^  [^ ]/ { inblk=0 }
		inblk && /^[^ ]/   { inblk=0 }
		inblk && $0 ~ "^    " key ":[ \t]*\\|[ \t]*$" { incontent=1; next }
	' "$MANIFEST"
}
# The list of source names under `sources:`.
yaml_sources() {
	awk '
		/^sources:[ \t]*$/ { ins=1; next }
		ins && /^[^ ]/ { ins=0 }
		ins && /^  [^ ]+:[ \t]*$/ { s=$0; sub(/^  /, "", s); sub(/:[ \t]*$/, "", s); print s }
	' "$MANIFEST"
}

# ---- helpers -------------------------------------------------------------------------------
fail() { echo "FAIL [$1] $2: $3" >&2; exit 1; }

# Fetch a manifest URL (http(s):// or local:REL) into $2.
fetch() {
	local url="$1" dest="$2"
	case "$url" in
		http://*|https://*) curl -fsSL --retry 3 --retry-delay 2 -o "$dest" "$url" ;;
		local:*)            cp "$MANIFEST_DIR/${url#local:}" "$dest" ;;
		*)                  return 3 ;;
	esac
}

# Extract a .dsc's Checksums-Sha256 body (the lines between that header and the next header),
# normalized to `<sha256> <size> <name>` with single spaces, sorted — for a stable compare.
dsc_checksums() {
	awk '
		/^Checksums-Sha256:[ \t]*$/ { inc=1; next }
		inc && /^[^ ]/ { inc=0 }
		inc { sub(/^[ \t]+/, ""); print }
	' "$1" | awk '{ $1=$1; print }' | sort
}
norm_block() { awk 'NF { $1=$1; print }' | sort; }

# ---- per-source verification ---------------------------------------------------------------
verify_source() {
	local src="$1"

	local signer_fpr signer_key_file dsc_url dsc_sha256 orig_url orig_sha256 orig_name
	signer_fpr="$(yaml_scalar "$src" signer_fingerprint)"
	signer_key_file="$(yaml_scalar "$src" signer_key_file)"
	dsc_url="$(yaml_scalar "$src" dsc_url)"
	dsc_sha256="$(yaml_scalar "$src" dsc_sha256)"
	orig_url="$(yaml_scalar "$src" orig_tar_url)"
	orig_sha256="$(yaml_scalar "$src" orig_tar_sha256)"
	orig_name="$(yaml_scalar "$src" orig_tar_name)"

	# --- import the pinned signer key into the isolated keyring ---
	local keypath="$signer_key_file"
	case "$keypath" in /*) : ;; *) keypath="$KEYS_BASE/$keypath" ;; esac
	[ -r "$keypath" ] || fail "$src" signer_key_file "key file not readable: $keypath"
	"${GPG[@]}" --import "$keypath" >/dev/null 2>&1 \
		|| fail "$src" signer_key_file "gpg failed to import $keypath"

	# --- fetch the .dsc ---
	local dsc="$WORKDIR/$src.dsc"
	fetch "$dsc_url" "$dsc" || fail "$src" dsc_url "could not fetch $dsc_url"

	# --- (integrity) recorded .dsc sha256 ---
	local got_dsc; got_dsc="$(sha256sum "$dsc" | awk '{print $1}')"
	[ "$got_dsc" = "$dsc_sha256" ] \
		|| fail "$src" dsc_sha256 "expected $dsc_sha256, got $got_dsc"

	# --- (AUTHORITY) GPG-verify the .dsc against the pinned signer ---
	local status="$WORKDIR/$src.status"
	"${GPG[@]}" --status-fd 3 --verify "$dsc" 3>"$status" >/dev/null 2>&1 || true
	if grep -q '^\[GNUPG:\] BADSIG' "$status"; then
		fail "$src" dsc_signature "signature invalid (BADSIG) — .dsc content does not match its signature"
	fi
	if grep -qE '^\[GNUPG:\] (GOODSIG|EXPKEYSIG)' "$status"; then
		# Signature math is valid (EXPKEYSIG = good sig from a since-expired key). Confirm the
		# signing key (or its primary) is the pinned fingerprint.
		local sign_fpr prim_fpr want; want="${signer_fpr^^}"
		sign_fpr="$(awk '/^\[GNUPG:\] VALIDSIG/ {print toupper($3); exit}' "$status")"
		prim_fpr="$(awk '/^\[GNUPG:\] VALIDSIG/ {print toupper($NF); exit}' "$status")"
		if [ "$sign_fpr" != "$want" ] && [ "$prim_fpr" != "$want" ]; then
			fail "$src" signer_fingerprint "good signature by $sign_fpr (primary $prim_fpr), pin expects $want"
		fi
	else
		# No good signature and no bad signature => the signature was made by some key that is
		# not the pinned one we imported (NO_PUBKEY / ERRSIG). That is a signer mismatch.
		local actual; actual="$(awk '/^\[GNUPG:\] (NO_PUBKEY|ERRSIG)/ {print toupper($3); exit}' "$status")"
		[ -n "$actual" ] || actual="unknown/none"
		fail "$src" signer_fingerprint "signer mismatch — .dsc signed by key 0x$actual, pin expects ${signer_fpr^^}"
	fi

	# --- (c) manifest's copied checksums must equal the verified .dsc's own section ---
	local dsc_ck man_ck
	dsc_ck="$(dsc_checksums "$dsc")"
	man_ck="$(yaml_block "$src" dsc_checksums_sha256 | norm_block)"
	[ "$dsc_ck" = "$man_ck" ] \
		|| fail "$src" dsc_checksums_sha256 "manifest checksums differ from the verified .dsc's Checksums-Sha256"

	# --- chain closure: the pinned orig sha256 must equal the .dsc's line for that file ---
	local dsc_orig_sha
	dsc_orig_sha="$(printf '%s\n' "$dsc_ck" | awk -v f="$orig_name" '$3==f {print tolower($1); exit}')"
	[ -n "$dsc_orig_sha" ] \
		|| fail "$src" orig_tar_name "$orig_name not listed in the .dsc's Checksums-Sha256"
	[ "$dsc_orig_sha" = "${orig_sha256,,}" ] \
		|| fail "$src" orig_tar_sha256 "pin ($orig_sha256) != .dsc checksum ($dsc_orig_sha) for $orig_name"

	# --- (ARTIFACT) download the .orig.tar and hash it ---
	local orig="$WORKDIR/$orig_name"
	fetch "$orig_url" "$orig" || fail "$src" orig_tar_url "could not fetch $orig_url"
	local got_orig; got_orig="$(sha256sum "$orig" | awk '{print $1}')"
	[ "$got_orig" = "$orig_sha256" ] \
		|| fail "$src" orig_tar_sha256 "checksum mismatch — expected $orig_sha256, got $got_orig"

	# --- (LINEAGE) git tags still resolve to the pinned SHAs ---
	if [ "$DO_LINEAGE" -eq 1 ]; then
		verify_lineage "$src" \
			"$(yaml_scalar "$src" upstream_repo)" "$(yaml_scalar "$src" upstream_tag)" \
			"$(yaml_scalar "$src" upstream_tag_sha)" "$(yaml_scalar "$src" upstream_commit_sha)" \
			upstream
		verify_lineage "$src" \
			"$(yaml_scalar "$src" salsa_repo)" "$(yaml_scalar "$src" salsa_tag)" \
			"$(yaml_scalar "$src" salsa_tag_sha)" "$(yaml_scalar "$src" salsa_commit_sha)" \
			salsa
	fi

	# --- (4th link authority) pinned debian_tar_sha256 == the verified .dsc's own line ---
	local deb_name deb_url deb_sha256 dsc_deb_sha
	deb_name="$(yaml_scalar "$src" debian_tar_name)"
	deb_url="$(yaml_scalar "$src" debian_tar_url)"
	deb_sha256="$(yaml_scalar "$src" debian_tar_sha256)"
	[ -n "$deb_name" ] || fail "$src" debian_tar_name "missing debian_tar_name in manifest"
	dsc_deb_sha="$(printf '%s\n' "$dsc_ck" | awk -v f="$deb_name" '$3==f {print tolower($1); exit}')"
	[ -n "$dsc_deb_sha" ] \
		|| fail "$src" debian_tar_name "$deb_name not listed in the .dsc's Checksums-Sha256"
	[ "$dsc_deb_sha" = "${deb_sha256,,}" ] \
		|| fail "$src" debian_tar_sha256 "pin ($deb_sha256) != .dsc checksum ($dsc_deb_sha) for $deb_name"

	# --- (PACKAGING) download the .debian.tar.xz, hash it, then prove its debian/ tree is
	#     byte-identical to the pinned salsa tag's debian/ tree (canonical manifest) ---
	local deb="$WORKDIR/$deb_name"
	fetch "$deb_url" "$deb" || fail "$src" debian_tar_url "could not fetch $deb_url"
	local got_deb; got_deb="$(sha256sum "$deb" | awk '{print $1}')"
	[ "$got_deb" = "$deb_sha256" ] \
		|| fail "$src" debian_tar_sha256 "checksum mismatch — expected $deb_sha256, got $got_deb"
	verify_packaging_tree "$src" "$deb" \
		"$(yaml_scalar "$src" salsa_repo)" "$(yaml_scalar "$src" salsa_tag)"

	echo "ok   [$src] lineage + .dsc signature + checksums + .orig.tar + debian/ tree verified"
}

# git ls-remote a tag and confirm both the tag-object SHA and the peeled commit SHA.
verify_lineage() {
	local src="$1" repo="$2" tag="$3" want_tag="$4" want_commit="$5" which="$6"
	local out; out="$(git ls-remote --tags "$repo" "$tag" "${tag}^{}" 2>/dev/null || true)"
	[ -n "$out" ] || fail "$src" "${which}_tag" "git ls-remote returned nothing for $tag @ $repo"
	local got_tag got_commit
	got_tag="$(printf '%s\n'    "$out" | awk -v t="refs/tags/$tag"      '$2==t   {print $1; exit}')"
	got_commit="$(printf '%s\n' "$out" | awk -v t="refs/tags/$tag^{}"   '$2==t   {print $1; exit}')"
	[ -n "$got_commit" ] || got_commit="$got_tag"   # lightweight tag: object == commit
	[ "$got_tag" = "$want_tag" ] \
		|| fail "$src" "${which}_tag_sha" "$tag object is $got_tag, pin expects $want_tag"
	[ "$got_commit" = "$want_commit" ] \
		|| fail "$src" "${which}_commit_sha" "$tag commit is $got_commit, pin expects $want_commit"
}

# Canonical metadata manifest of a debian/ tree, one line per entry, tab-separated:
#   <relative-path> <type(file|dir|symlink)> <exec-bit(0|1|-)> <symlink-target|-> <sha256|->
# Symlinks are tested before -d/-f (those follow links); exec bit + content hash let the
# compare catch mode/content drift that a filename-only listing would miss.
canon_tree_manifest() {
	( cd "$1" && find . -mindepth 1 \( -type f -o -type d -o -type l \) | LC_ALL=C sort | while IFS= read -r p; do
		rel="${p#./}"
		if [ -L "$p" ]; then
			printf '%s\tsymlink\t-\t%s\t-\n' "$rel" "$(readlink "$p")"
		elif [ -d "$p" ]; then
			printf '%s\tdir\t-\t-\t-\n' "$rel"
		elif [ -f "$p" ]; then
			if [ -x "$p" ]; then x=1; else x=0; fi
			printf '%s\tfile\t%s\t-\t%s\n' "$rel" "$x" "$(sha256sum "$p" | awk '{print $1}')"
		fi
	done )
}

# 4th link: prove the .debian.tar.xz's debian/ tree equals the pinned salsa tag's debian/
# tree. The salsa tree comes from a shallow clone of salsa_tag (real run) or a `local:` dir
# (offline fixtures). Fails closed naming the first differing path AND which field diverged.
verify_packaging_tree() {
	local src="$1" deb="$2" salsa_repo="$3" salsa_tag="$4"

	local deb_extract="$WORKDIR/debtree-$src"
	rm -rf "$deb_extract"; mkdir -p "$deb_extract"
	tar -C "$deb_extract" -xf "$deb" >/dev/null 2>&1 \
		|| fail "$src" debian_tar_name "could not extract $(basename "$deb")"
	[ -d "$deb_extract/debian" ] \
		|| fail "$src" debian_tar_name "$(basename "$deb") has no top-level debian/ directory"

	local salsa_debian
	case "$salsa_repo" in
		local:*)
			salsa_debian="$MANIFEST_DIR/${salsa_repo#local:}/debian"
			[ -d "$salsa_debian" ] \
				|| fail "$src" salsa_repo "local salsa tree has no debian/ at $salsa_debian"
			;;
		*)
			local salsa_clone="$WORKDIR/salsatree-$src"
			rm -rf "$salsa_clone"
			git clone --depth 1 --branch "$salsa_tag" --quiet "$salsa_repo" "$salsa_clone" >/dev/null 2>&1 \
				|| fail "$src" salsa_tag "could not shallow-clone $salsa_tag from $salsa_repo"
			salsa_debian="$salsa_clone/debian"
			[ -d "$salsa_debian" ] \
				|| fail "$src" salsa_tag "$salsa_tag checkout has no debian/ directory"
			;;
	esac

	local salsa_man="$WORKDIR/man-salsa-$src.txt" deb_man="$WORKDIR/man-deb-$src.txt"
	canon_tree_manifest "$salsa_debian"      > "$salsa_man"
	canon_tree_manifest "$deb_extract/debian" > "$deb_man"

	local diffout first
	diffout="$(awk -F'\t' '
		FNR==NR { s[$1]=$0; next }
		{
			seen[$1]=1
			if (!($1 in s)) { print $1 "\textra-entry\tin .debian.tar.xz tree but not in salsa tree"; next }
			split(s[$1], sf, "\t")
			if (sf[2]!=$2) { print $1 "\tfile-type\tsalsa=" sf[2] " debtar=" $2; next }
			if (sf[3]!=$3) { print $1 "\texecutable-bit\tsalsa=" sf[3] " debtar=" $3; next }
			if (sf[4]!=$4) { print $1 "\tsymlink-target\tsalsa=" sf[4] " debtar=" $4; next }
			if (sf[5]!=$5) { print $1 "\tcontent-sha256\tsalsa=" sf[5] " debtar=" $5; next }
		}
		END { for (p in s) if (!(p in seen)) print p "\tmissing-entry\tin salsa tree but not in .debian.tar.xz tree" }
	' "$salsa_man" "$deb_man" | LC_ALL=C sort)"

	first="${diffout%%$'\n'*}"
	if [ -n "$first" ]; then
		local dpath dfield ddetail
		dpath="$(printf '%s' "$first" | cut -f1)"
		dfield="$(printf '%s' "$first" | cut -f2)"
		ddetail="$(printf '%s' "$first" | cut -f3-)"
		fail "$src" debian_tree "salsa vs .debian.tar.xz differ at '$dpath' [$dfield]: $ddetail"
	fi
}

# ---- main ----------------------------------------------------------------------------------
echo "verify-upstream-pins: manifest=$MANIFEST  lineage=$([ "$DO_LINEAGE" -eq 1 ] && echo on || echo off)"
echo "                      isolated GNUPGHOME=$GNUPGHOME"

sources="$(yaml_sources)"
[ -n "$sources" ] || { echo "verify-upstream-pins: no sources found in manifest" >&2; exit 2; }

count=0
for src in $sources; do
	[ -z "$ONLY_SOURCE" ] || [ "$src" = "$ONLY_SOURCE" ] || continue
	verify_source "$src"
	count=$((count + 1))
done
[ "$count" -gt 0 ] || { echo "verify-upstream-pins: no matching source '$ONLY_SOURCE'" >&2; exit 2; }

echo "PASS: $count source(s) fully provenance-verified"
