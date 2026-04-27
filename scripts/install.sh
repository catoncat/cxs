#!/usr/bin/env bash
# Install the cxs CLI from a GitHub Release binary.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/catoncat/cxs/main/scripts/install.sh | bash
#
# Override the destination with CXS_INSTALL_DIR (default: ~/.local/bin).

set -euo pipefail

OWNER="catoncat"
REPO="cxs"
INSTALL_DIR="${CXS_INSTALL_DIR:-$HOME/.local/bin}"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH_RAW="$(uname -m)"

case "$ARCH_RAW" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64) ARCH="x64" ;;
  *) echo "unsupported arch: $ARCH_RAW" >&2; exit 1 ;;
esac

case "$OS" in
  darwin) EXT=""; PLATFORM="darwin-$ARCH" ;;
  linux) EXT=""; PLATFORM="linux-$ARCH" ;;
  msys*|cygwin*|mingw*) EXT=".exe"; PLATFORM="windows-$ARCH" ;;
  *) echo "unsupported os: $OS" >&2; exit 1 ;;
esac

ASSET="cxs-${PLATFORM}${EXT}"
URL="https://github.com/${OWNER}/${REPO}/releases/latest/download/${ASSET}"

mkdir -p "$INSTALL_DIR"
TARGET="$INSTALL_DIR/cxs${EXT}"

echo "downloading $ASSET from $URL"
curl -fsSL --proto '=https' --tlsv1.2 -o "$TARGET" "$URL"
chmod +x "$TARGET"

echo
echo "installed: $TARGET"
echo
"$TARGET" --version || {
  echo "warning: just-installed binary failed to run; remove $TARGET and retry" >&2
  exit 1
}

case ":$PATH:" in
  *":$INSTALL_DIR:"*)
    echo
    echo "ready: cxs --help"
    ;;
  *)
    echo
    echo "tip: $INSTALL_DIR is not in PATH yet; add to your shell rc:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac
