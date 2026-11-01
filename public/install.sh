#!/bin/sh
# Installs the sikrets CLI from GitHub releases, verified against the release's SHA256SUMS.
#
#   curl -fsSL https://sikrets.usetennant.com/install.sh | sh
#
# Options (environment variables):
#   SIKRETS_VERSION      tag to install, e.g. v0.1.0 (default: latest release)
#   SIKRETS_INSTALL_DIR  where to put the binary (default: /usr/local/bin as root, else ~/.local/bin)
set -eu

REPO="${SIKRETS_REPO:-Munasco/sikrets}"
VERSION="${SIKRETS_VERSION:-latest}"

say() { printf 'sikrets: %s\n' "$1" >&2; }
fail() { say "$1"; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

fetch() {
  if has curl; then curl -fsSL --proto '=https' --tlsv1.2 -o "$2" "$1"
  elif has wget; then wget -q --https-only -O "$2" "$1"
  else fail "needs curl or wget"; fi
}

sha256() {
  if has sha256sum; then sha256sum "$1" | cut -d ' ' -f 1
  elif has shasum; then shasum -a 256 "$1" | cut -d ' ' -f 1
  else fail "needs sha256sum or shasum to verify the download"; fi
}

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  MINGW* | MSYS* | CYGWIN*) fail "on Windows, download sikrets-windows-x64.exe from https://github.com/$REPO/releases" ;;
  *) fail "unsupported OS: $(uname -s)" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "unsupported CPU: $(uname -m)" ;;
esac
# A shell running under Rosetta reports x86_64; the native arm64 build is faster.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi

asset="sikrets-$os-$arch"
if [ "$VERSION" = latest ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

if [ -n "${SIKRETS_INSTALL_DIR:-}" ]; then dir="$SIKRETS_INSTALL_DIR"
elif [ "$(id -u)" = 0 ]; then dir=/usr/local/bin
else dir="$HOME/.local/bin"; fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

say "downloading $asset ($VERSION)"
fetch "$base/$asset" "$tmp/$asset"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS"

expected="$(awk -v f="$asset" '{ n = $2; sub(/^\*/, "", n) } n == f { print $1; exit }' "$tmp/SHA256SUMS")"
[ -n "$expected" ] || fail "$asset is not listed in SHA256SUMS"
actual="$(sha256 "$tmp/$asset")"
[ "$actual" = "$expected" ] || fail "checksum mismatch for $asset (expected $expected, got $actual); nothing was installed"

mkdir -p "$dir"
chmod 755 "$tmp/$asset"
mv "$tmp/$asset" "$dir/sikrets"
say "installed $("$dir/sikrets" --version) to $dir/sikrets"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) say "$dir is not on your PATH. Add it: export PATH=\"$dir:\$PATH\"" ;;
esac
