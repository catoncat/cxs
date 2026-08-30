#!/bin/sh
# Install a verified standalone Sherlog binary without Node.js.
#
# Supported environment variables:
#   SHERLOG_VERSION                 release version (for example 0.5.0 or v0.5.0; default: latest)
#   SHERLOG_INSTALL_DIR             destination directory (default: XDG_BIN_HOME or $HOME/.local/bin)
#   SHERLOG_FORCE=1                 explicitly replace existing shlog/sherlog paths
#   SHERLOG_VERIFY_ATTESTATION=1    additionally verify GitHub artifact provenance with gh
#   SHERLOG_REPOSITORY              GitHub owner/repository (default: catoncat/sherlog)
#   SHERLOG_DOWNLOAD_BASE_URL       release download base URL (mirrors/tests)
#   SHERLOG_ALLOW_INSECURE=1        explicitly allow a non-HTTPS download base (tests only)

set -eu

say() {
  printf '%s\n' "$*"
}

die() {
  printf 'sherlog installer: %s\n' "$*" >&2
  exit 1
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

path_exists() {
  [ -e "$1" ] || [ -L "$1" ]
}

repository=${SHERLOG_REPOSITORY:-catoncat/sherlog}
requested_version=${SHERLOG_VERSION:-latest}
force=${SHERLOG_FORCE:-0}
verify_attestation=${SHERLOG_VERIFY_ATTESTATION:-0}
allow_insecure=${SHERLOG_ALLOW_INSECURE:-0}

printf '%s\n' "$repository" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' ||
  die "SHERLOG_REPOSITORY must be owner/repository"
case "$force" in
  0 | 1) ;;
  *) die "SHERLOG_FORCE must be 0 or 1" ;;
esac
case "$verify_attestation" in
  0 | 1) ;;
  *) die "SHERLOG_VERIFY_ATTESTATION must be 0 or 1" ;;
esac
case "$allow_insecure" in
  0 | 1) ;;
  *) die "SHERLOG_ALLOW_INSECURE must be 0 or 1" ;;
esac

for command_name in curl tar awk grep sed mktemp mkdir cp chmod mv ln rm uname tr; do
  need_command "$command_name"
done

if command -v sha256sum >/dev/null 2>&1; then
  sha256_file() {
    sha256sum "$1" | awk '{print $1}'
  }
elif command -v shasum >/dev/null 2>&1; then
  sha256_file() {
    shasum -a 256 "$1" | awk '{print $1}'
  }
else
  die "sha256sum or shasum is required"
fi

kernel=$(uname -s)
machine=$(uname -m)
case "$kernel:$machine" in
  Darwin:arm64 | Darwin:aarch64)
    target=aarch64-apple-darwin
    ;;
  Darwin:x86_64 | Darwin:amd64)
    die "Intel macOS is not supported; Sherlog requires Apple Silicon macOS"
    ;;
  Linux:x86_64 | Linux:amd64)
    for musl_loader in /lib/ld-musl-*.so.1 /usr/lib/ld-musl-*.so.1; do
      if [ -e "$musl_loader" ]; then
        die "Linux musl is not supported by the GNU release archive"
      fi
    done
    target=x86_64-unknown-linux-gnu
    ;;
  *)
    die "unsupported platform: ${kernel} ${machine}"
    ;;
esac

fetch() {
  fetch_url=$1
  fetch_destination=$2
  case "$fetch_url" in
    https://*)
      curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
        --retry 3 --retry-delay 1 --output "$fetch_destination" "$fetch_url"
      ;;
    *)
      [ "$allow_insecure" = "1" ] ||
        die "refusing non-HTTPS download; set SHERLOG_ALLOW_INSECURE=1 only for a trusted test mirror"
      curl --fail --silent --show-error --location \
        --retry 3 --retry-delay 1 --output "$fetch_destination" "$fetch_url"
      ;;
  esac
}

if [ "$requested_version" = "latest" ]; then
  latest_page="https://github.com/${repository}/releases/latest"
  latest_url=$(curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
    --retry 3 --retry-delay 1 --output /dev/null --write-out '%{url_effective}' "$latest_page") ||
    die "could not resolve the latest release"
  tag=${latest_url##*/}
  tag=${tag%%\?*}
  case "$tag" in
    v*) version=${tag#v} ;;
    *) die "latest release did not resolve to a v-prefixed tag: $latest_url" ;;
  esac
else
  version=${requested_version#v}
  tag="v${version}"
fi

printf '%s\n' "$version" |
  grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$' ||
  die "unsupported release version: $requested_version"

download_base=${SHERLOG_DOWNLOAD_BASE_URL:-https://github.com/${repository}/releases/download}
download_base=${download_base%/}
package_name="sherlog-v${version}-${target}"
asset="${package_name}.tar.gz"
archive_url="${download_base}/${tag}/${asset}"
checksums_url="${download_base}/${tag}/SHA256SUMS"

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/sherlog-install.XXXXXX") ||
  die "could not create temporary directory"
binary_tmp=
alias_tmp=
cleanup() {
  if [ -n "$binary_tmp" ]; then
    rm -f "$binary_tmp"
  fi
  if [ -n "$alias_tmp" ]; then
    rm -f "$alias_tmp"
  fi
  rm -rf "$tmp_dir"
}
trap cleanup 0
trap 'exit 1' 1 2 15

archive_path="${tmp_dir}/${asset}"
checksums_path="${tmp_dir}/SHA256SUMS"
say "Downloading Sherlog v${version} for ${target}..."
fetch "$archive_url" "$archive_path"
fetch "$checksums_url" "$checksums_path"

expected_sha=$(awk -v asset="$asset" '
  $2 == asset { count += 1; digest = $1 }
  END {
    if (count != 1) exit 1
    print digest
  }
' "$checksums_path") || die "SHA256SUMS does not contain exactly one entry for ${asset}"
printf '%s\n' "$expected_sha" | grep -Eq '^[0-9A-Fa-f]{64}$' ||
  die "invalid SHA-256 value for ${asset}"
actual_sha=$(sha256_file "$archive_path")
expected_sha=$(printf '%s' "$expected_sha" | tr '[:upper:]' '[:lower:]')
actual_sha=$(printf '%s' "$actual_sha" | tr '[:upper:]' '[:lower:]')
[ "$actual_sha" = "$expected_sha" ] ||
  die "checksum mismatch for ${asset}: expected ${expected_sha}, got ${actual_sha}"

if [ "$verify_attestation" = "1" ]; then
  need_command gh
  say "Verifying GitHub artifact attestation..."
  gh attestation verify "$archive_path" --repo "$repository" >/dev/null ||
    die "GitHub artifact attestation verification failed"
fi

if ! tar -tzf "$archive_path" | awk -v root="$package_name" '
  $0 == root || $0 == root "/" { next }
  index($0, root "/") == 1 && $0 !~ /(^|\/)\.\.(\/|$)/ { next }
  { exit 1 }
'; then
  die "archive contains an unexpected or unsafe path"
fi
tar -xzf "$archive_path" -C "$tmp_dir" "${package_name}/shlog"
staged_binary="${tmp_dir}/${package_name}/shlog"
[ -f "$staged_binary" ] && [ ! -L "$staged_binary" ] ||
  die "archive does not contain a regular shlog binary"
chmod 0755 "$staged_binary"
staged_version=$("$staged_binary" --version | awk '{print $NF}' | sed 's/^v//') ||
  die "downloaded shlog binary did not run"
[ "$staged_version" = "$version" ] ||
  die "downloaded binary reports v${staged_version}, expected v${version}"
"$staged_binary" --help >/dev/null || die "downloaded shlog --help smoke failed"

if [ -n "${SHERLOG_INSTALL_DIR:-}" ]; then
  install_dir=$SHERLOG_INSTALL_DIR
elif [ -n "${XDG_BIN_HOME:-}" ]; then
  install_dir=$XDG_BIN_HOME
elif [ -n "${HOME:-}" ]; then
  install_dir=$HOME/.local/bin
else
  die "set SHERLOG_INSTALL_DIR because HOME is not available"
fi
case "$install_dir" in
  /) die "refusing to install directly into /" ;;
  /*) ;;
  *) die "SHERLOG_INSTALL_DIR must be an absolute path" ;;
esac

mkdir -p "$install_dir" || die "could not create ${install_dir}; the installer never invokes sudo"
[ -d "$install_dir" ] && [ -w "$install_dir" ] ||
  die "install directory is not writable: ${install_dir}; choose a user-writable SHERLOG_INSTALL_DIR"

shlog_path="${install_dir}/shlog"
sherlog_path="${install_dir}/sherlog"
if [ -d "$shlog_path" ] || [ -d "$sherlog_path" ]; then
  die "refusing to replace an existing directory at ${shlog_path} or ${sherlog_path}"
fi
if [ "$force" != "1" ]; then
  path_exists "$shlog_path" &&
    die "${shlog_path} already exists; set SHERLOG_FORCE=1 to replace it explicitly"
  path_exists "$sherlog_path" &&
    die "${sherlog_path} already exists; set SHERLOG_FORCE=1 to replace it explicitly"
fi

binary_tmp=$(mktemp "${install_dir}/.shlog.install.XXXXXX") ||
  die "could not stage shlog in ${install_dir}"
cp "$staged_binary" "$binary_tmp"
chmod 0755 "$binary_tmp"
test "$("$binary_tmp" --version | awk '{print $NF}' | sed 's/^v//')" = "$version" ||
  die "staged install binary failed its version smoke"

alias_tmp=$(mktemp "${install_dir}/.sherlog.install.XXXXXX") ||
  die "could not stage sherlog alias in ${install_dir}"
rm -f "$alias_tmp"
ln -s shlog "$alias_tmp"

mv -f "$binary_tmp" "$shlog_path"
binary_tmp=
mv -f "$alias_tmp" "$sherlog_path"
alias_tmp=

installed_version=$("$shlog_path" --version | awk '{print $NF}' | sed 's/^v//') ||
  die "installed shlog did not run"
[ "$installed_version" = "$version" ] ||
  die "installed shlog reports an unexpected version: ${installed_version}"
test "$("$sherlog_path" --version | awk '{print $NF}' | sed 's/^v//')" = "$version" ||
  die "installed sherlog alias did not run"

say "Installed shlog and sherlog v${version} in ${install_dir}"
case ":${PATH:-}:" in
  *":${install_dir}:"*) ;;
  *) say "Add ${install_dir} to PATH to run shlog from any shell." ;;
esac
