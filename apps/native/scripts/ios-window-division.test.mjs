import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("fold layout uses the current window and ignores regions outside a split window", { skip: process.platform !== "darwin" }, () => {
  const ios = fileURLToPath(new URL("../src-tauri/ios/", import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), "norr-window-division-"));
  try {
    const binary = join(directory, "check");
    execFileSync("xcrun", ["swiftc", join(ios, "Sources/NorrMobile/WindowDivision.swift"),
      join(ios, "Tests/WindowDivisionTests.swift"), "-o", binary]);
    execFileSync(binary);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
