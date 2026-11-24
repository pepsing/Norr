import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

test("Apple widget cache clears safely and scopes Siri readbacks to account and vehicle", { skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync(join(tmpdir(), "norr-widget-readback-test-"));
  try {
    const ios = fileURLToPath(new URL("../src-tauri/ios/", import.meta.url));
    const executable = join(root, "check-widget-storage");
    execFileSync("xcrun", ["swiftc", join(ios, "Sources/NorrWidgetSupport/WidgetStorage.swift"),
      join(ios, "Tests/WidgetStorageTests.swift"), "-o", executable]);
    assert.match(execFileSync(executable, [], { encoding: "utf8" }), /scoped Siri readback/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("sandboxed macOS widget resolves the main app snapshot directory", { skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync(join(tmpdir(), "norr-widget-storage-test-"));
  try {
    const app = join(root, "Probe.app");
    const executable = join(app, "Contents/MacOS/probe");
    mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
    writeFileSync(join(app, "Contents/Info.plist"), JSON.stringify({
      CFBundleIdentifier: "app.norr.mac.widget-storage-test",
      CFBundleExecutable: "probe",
    }));
    execFileSync("plutil", ["-convert", "xml1", join(app, "Contents/Info.plist")]);
    const source = join(root, "Probe.swift");
    writeFileSync(source, `
import Foundation
@main struct Probe {
  static func main() {
    precondition(WidgetStorage.directory()?.path == CommandLine.arguments[1])
    print("PASS")
  }
}
`);
    const directory = fileURLToPath(new URL("../src-tauri/macos/", import.meta.url));
    execFileSync("xcrun", ["swiftc", join(directory, "WidgetStorage.swift"), source, "-o", executable]);
    execFileSync("codesign", ["--force", "--sign", "-", "--entitlements", join(directory, "Widgets.entitlements"), app], { stdio: "pipe" });
    const expected = join(homedir(), "Library/Application Support/app.norr.mac/widgets");
    assert.equal(execFileSync(executable, [expected], { encoding: "utf8" }).trim(), "PASS");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
