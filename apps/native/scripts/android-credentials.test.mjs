import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Android storage accepts every credential account used by the Rust core", () => {
  const core = readFileSync(new URL("../../../crates/vehicle-core/src/credentials.rs", import.meta.url), "utf8");
  const android = readFileSync(new URL("../src-tauri/gen/android/app/src/main/java/app/norr/mobile/NorrCredentialStore.kt", import.meta.url), "utf8");
  const names = source => new Set([...source.matchAll(/"((?:polestar-[a-z-]+)|device-id)"/g)].map(match => match[1]));
  assert.deepEqual(names(android), names(core));
});
