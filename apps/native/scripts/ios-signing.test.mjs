import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { prepareIOSForResigning } from "./finalize-ios.mjs";

test("personal-signing IPA preserves App Groups on both executables without a certificate", { skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync(join(tmpdir(), "norr-signing-test-"));
  try {
    const app = join(root, "Norr.app");
    const extension = join(app, "PlugIns/NorrWidgets.appex");
    mkdirSync(extension, { recursive: true });
    const source = join(root, "main.c");
    writeFileSync(source, "int main(void) { return 0; }\n");
    const sdk = execFileSync("xcrun", ["--sdk", "iphoneos", "--show-sdk-path"], { encoding: "utf8" }).trim();
    for (const [bundle, name, id] of [[app, "Norr", "app.norr.ios"], [extension, "NorrWidgets", "app.norr.ios.widgets"]]) {
      writeFileSync(join(bundle, "Info.plist"), JSON.stringify({ CFBundleExecutable: name, CFBundleIdentifier: id }));
      execFileSync("plutil", ["-convert", "xml1", join(bundle, "Info.plist")]);
      writeFileSync(join(bundle, "embedded.mobileprovision"), "stale signing profile");
      execFileSync("xcrun", ["clang", "-target", "arm64-apple-ios17.0", "-isysroot", sdk, source, "-o", join(bundle, name)]);
    }
    prepareIOSForResigning(app);
    for (const bundle of [app, extension]) {
      assert.equal(existsSync(join(bundle, "embedded.mobileprovision")), false);
      const signature = spawnSync("codesign", ["--display", "--verbose=4", bundle], { encoding: "utf8" });
      assert.equal(signature.status, 0);
      assert.match(signature.stderr, /Signature=adhoc/);
      assert.match(signature.stderr, /TeamIdentifier=not set/);
      assert.doesNotMatch(signature.stderr, /^Authority=/m);
      const result = execFileSync("codesign", ["-d", "--entitlements", ":-", bundle]);
      const permissions = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", "-"], { input: result }));
      assert.deepEqual(permissions, { "com.apple.security.application-groups": ["group.app.norr.widgets"] });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
