#!/bin/sh
# Build the pinned read-only helper using the same toolchain/cache as rocfl.
set -eu
case "${1:-}" in
    ""|--benchmarks) ;;
    *) echo "Usage: $0 [--benchmarks]" >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then
    echo "Usage: $0 [--benchmarks]" >&2
    exit 2
fi
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
build_dir="${SYMBIKNOW_BUILD_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/symbiknow/rocfl-build}"
export CARGO_HOME="$build_dir/cargo"
export RUSTUP_HOME="$build_dir/rustup"
export CARGO_TARGET_DIR="$build_dir/reader-target"
if [ ! -x "$CARGO_HOME/bin/cargo" ]; then
    sh "$project_dir/scripts/setup/install_rocfl.sh"
fi
"$CARGO_HOME/bin/cargo" build --release --locked --bin symbiknow-ocfl-reader \
    --manifest-path "$project_dir/native/ocfl-reader/Cargo.toml"
mkdir -p "$project_dir/.tools/native/bin"
install_binary() {
    install_stage=$(mktemp "$project_dir/.tools/native/bin/.install-XXXXXX")
    trap 'rm -f "$install_stage"' 0
    install -m 755 "$1" "$install_stage"
    # Existing readers keep their executable inode until they exit.
    mv -f "$install_stage" "$2"
}
install_binary "$CARGO_TARGET_DIR/release/symbiknow-ocfl-reader" \
    "$project_dir/.tools/native/bin/symbiknow-ocfl-reader"
"$project_dir/.tools/native/bin/symbiknow-ocfl-reader" --version
if [ "${1:-}" = --benchmarks ]; then
    "$CARGO_HOME/bin/cargo" build --release --locked --bin seed-library \
        --manifest-path "$project_dir/native/ocfl-reader/Cargo.toml"
    install_binary "$CARGO_TARGET_DIR/release/seed-library" \
        "$project_dir/.tools/native/bin/symbiknow-seed-library"
fi
