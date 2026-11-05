#!/bin/sh
# Installs openforge from its GitHub releases.
#
#   curl -fsSL https://github.com/floris3456/openforge/releases/latest/download/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- 0.0.1        # a given version
#
# Layout (the same one `openforge upgrade` keeps):
#   ${XDG_DATA_HOME:-~/.local/share}/openforge/releases/<version>/openforge
#   ${XDG_DATA_HOME:-~/.local/share}/openforge/current -> releases/<version>
#   ~/.local/bin/openforge -> <data>/current/openforge
#
# OPENFORGE_RELEASE_URL replaces https://github.com/floris3456/openforge/releases, for local release servers.
set -eu

base="${OPENFORGE_RELEASE_URL:-https://github.com/floris3456/openforge/releases}"
base="${base%/}"
data="${XDG_DATA_HOME:-$HOME/.local/share}/openforge"
bin="$HOME/.local/bin"

fail() {
  printf 'openforge install: %s\n' "$1" >&2
  exit 1
}

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64 | Linux-amd64) platform=linux-x64 ;;
  Darwin-arm64 | Darwin-aarch64) platform=darwin-arm64 ;;
  *) fail "openforge is built for Linux x64 and macOS arm64 only, not $(uname -s) $(uname -m)." ;;
esac
asset="openforge-$platform.tar.gz"

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
else
  fail "curl or wget is needed to download openforge."
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  fail "sha256sum or shasum is needed to check the download."
fi

if [ -e "$bin/openforge" ] && [ ! -L "$bin/openforge" ]; then
  fail "$bin/openforge exists and is not a link; remove it and run the installer again."
fi

mkdir -p "$data/releases"
work="$(mktemp -d "$data/releases/.install-XXXXXX")"
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT TERM

requested="${1:-}"
requested="${requested#v}"
if [ -n "$requested" ]; then
  manifest_url="$base/download/v$requested/release.json"
else
  manifest_url="$base/latest/download/release.json"
fi
fetch "$manifest_url" "$work/release.json" || fail "could not download $manifest_url"
version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' "$work/release.json" | head -n 1)"
case "$version" in
  "" | */* | *[!0-9A-Za-z.+-]*) fail "release.json from $manifest_url names no valid version." ;;
esac
[ -z "$requested" ] || [ "$requested" = "$version" ] || fail "release.json for $requested names version $version."

printf 'Installing openforge %s for %s\n' "$version" "$platform"
fetch "$base/download/v$version/SHA256SUMS" "$work/SHA256SUMS" || fail "could not download SHA256SUMS of $version"
expected="$(awk -v name="$asset" '$2 == name || $2 == "*" name { print tolower($1); exit }' "$work/SHA256SUMS")"
[ -n "$expected" ] || fail "SHA256SUMS of $version does not list $asset."
fetch "$base/download/v$version/$asset" "$work/$asset" || fail "could not download $asset of $version"
actual="$(sha256 "$work/$asset")"
[ "$actual" = "$expected" ] || fail "the SHA-256 of $asset is $actual; SHA256SUMS lists $expected."

entries="$(tar -tzf "$work/$asset")" || fail "could not read $asset."
[ "$(printf '%s\n' "$entries" | sed 's#^\./##' | grep -v '^$')" = "openforge" ] || fail "$asset must hold only openforge."
mkdir "$work/unpacked"
tar -xzf "$work/$asset" -C "$work/unpacked" || fail "could not unpack $asset."
[ -f "$work/unpacked/openforge" ] && [ ! -L "$work/unpacked/openforge" ] || fail "openforge in $asset is not a regular file."
chmod 755 "$work/unpacked/openforge"
printed="$("$work/unpacked/openforge" --version 2>/dev/null)" || fail "the downloaded openforge does not run."
reported="$(printf '%s\n' "$printed" | awk 'NF { last = $NF } END { print last }')"
[ "${reported#v}" = "$version" ] || fail "the downloaded openforge reports \"$printed\", not $version."

mkdir -p "$data/releases/$version"
mv -f "$work/unpacked/openforge" "$data/releases/$version/openforge"

previous=""
[ -L "$data/current" ] && previous="$(basename "$(readlink "$data/current")")"
link="$data/current.$$"
rm -f "$link"
ln -s "releases/$version" "$link"
# One rename keeps `current` valid throughout; GNU mv needs -T and BSD mv -h not to move into the old target.
mv -T "$link" "$data/current" 2>/dev/null || mv -h "$link" "$data/current" 2>/dev/null || {
  rm -f "$link"
  ln -sfn "releases/$version" "$data/current"
}

mkdir -p "$bin"
ln -sfn "$data/current/openforge" "$bin/openforge"

printf 'openforge %s is installed: %s\n' "$version" "$bin/openforge"
if [ -n "$previous" ] && [ "$previous" != "$version" ]; then
  printf 'It replaced openforge %s. Next time, run "openforge upgrade": it switches while chats run and can roll back.\n' "$previous"
fi
case ":$PATH:" in
  *":$bin:"*) ;;
  *) printf '%s is not on your PATH. Add it, for example:\n  export PATH="%s:$PATH"\n' "$bin" "$bin" ;;
esac
