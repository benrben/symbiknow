#!/bin/sh
# Browser-test coverage for frontend/src: build with source maps, run Playwright, write LCOV.
# Usage: frontend/scripts/coverage.sh OUTPUT_LCOV
set -eu
output=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
cd "$(dirname "$0")/.."
if [ -d ../.tools/node/bin ]; then PATH="$PWD/../.tools/node/bin:$PATH"; export PATH; fi
work="$PWD/../.quality/ui-coverage"
rm -rf "$work"
npx vite build --sourcemap --minify false --outDir "$work/build" --emptyOutDir --logLevel warn
# CI=1 stops Playwright from reusing an uninstrumented server already on the port.
CI=1 UI_COVERAGE_DIR="$work/raw" SYMBIKNOW_UI_BUILD="$work/build" npx playwright test
node scripts/coverage-report.mjs "$work/raw" "$work/build" "$output"
