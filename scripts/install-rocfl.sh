#!/bin/sh
# Build the pinned native OCFL CLI; avoids Intel-only macOS release binaries.
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# Build caches stay outside the project so their crate lockfiles are not scanned as ours.
build_dir="${SYMBIKNOW_BUILD_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/symbiknow/rocfl-build}"
export CARGO_HOME="$build_dir/cargo"
export RUSTUP_HOME="$build_dir/rustup"
export CARGO_TARGET_DIR="$build_dir/target"
mkdir -p "$build_dir" "$project_dir/.tools"
if [ ! -x "$CARGO_HOME/bin/cargo" ]; then
    curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs -o "$build_dir/rustup-init.sh"
    sh "$build_dir/rustup-init.sh" -y --profile minimal --no-modify-path
fi
"$CARGO_HOME/bin/cargo" install rocfl --version 1.7.0 --no-default-features --locked \
    --root "$project_dir/.tools/native"
"$project_dir/.tools/native/bin/rocfl" --version
