#!/bin/sh
set -eu

native=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
sources="$native/src-tauri/gen/apple/Sources/norr/Siri"
tests="$native/src-tauri/ios/Tests"
build=$(mktemp -d)
trap 'rm -rf "$build"' EXIT

xcrun clang -fblocks -c "$tests/SiriBridgeFixture.c" -o "$build/siri-fixture.o"
xcrun swiftc -parse-as-library -import-objc-header "$sources/SiriBridge.h" \
  "$sources/SiriBridge.swift" "$tests/SiriBridgeTests.swift" "$build/siri-fixture.o" \
  -o "$build/check-siri"
"$build/check-siri"
