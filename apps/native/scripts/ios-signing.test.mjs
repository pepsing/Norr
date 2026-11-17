import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { prepareIOSForResigning, synchronizeEmbeddedVersions, verifyEmbeddedWatch, verifyIOSWidgetCommand } from "./finalize-ios.mjs";

test("IPA validation requires the widget Objective-C selector, not a command string", { skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync(join(tmpdir(), "norr-widget-command-test-"));
  try {
    const sdk = execFileSync("xcrun", ["--sdk", "iphoneos", "--show-sdk-path"], { encoding: "utf8" }).trim();
    for (const withCommand of [false, true]) {
      const source = join(root, "main.m");
      const executable = join(root, "Norr");
      const declaration = withCommand ? "- (BOOL)updateWidgets:(id)invoke error:(NSError **)error;" : "";
      const implementation = withCommand ? "- (BOOL)updateWidgets:(id)invoke error:(NSError **)error { return YES; }" : "";
      writeFileSync(source, `
#import <Foundation/Foundation.h>
#include <stdio.h>
@interface NorrPlugin : NSObject
${declaration}
@end
@implementation NorrPlugin
${implementation}
@end
int main(void) {
  puts("updateWidgets:error:");
  return [NorrPlugin new] == nil;
}
`);
      execFileSync("xcrun", ["clang", "-target", "arm64-apple-ios17.0", "-isysroot", sdk,
        "-fobjc-arc", "-framework", "Foundation", source, "-o", executable]);
      if (withCommand) {
        assert.doesNotThrow(() => verifyIOSWidgetCommand(executable));
      } else {
        assert.throws(() => verifyIOSWidgetCommand(executable), /Missing iOS widget command/);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("personal-signing IPA preserves distinct iOS and Watch groups through nested bundles", { skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync(join(tmpdir(), "norr-signing-test-"));
  try {
    const app = join(root, "Norr.app");
    const extension = join(app, "PlugIns/NorrWidgets.appex");
    const watch = join(app, "Watch/NorrWatch.app");
    const watchExtension = join(watch, "PlugIns/NorrWatchWidgets.appex");
    const bundles = [
      [app, "Norr", "app.norr.ios", "iphoneos", "arm64-apple-ios17.0", "group.app.norr.widgets"],
      [extension, "NorrWidgets", "app.norr.ios.widgets", "iphoneos", "arm64-apple-ios17.0", "group.app.norr.widgets"],
      [watch, "NorrWatch", "app.norr.ios.watchkitapp", "watchos", "arm64_32-apple-watchos10.0", "group.app.norr.watch"],
      [watchExtension, "NorrWatchWidgets", "app.norr.ios.watchkitapp.widgets", "watchos", "arm64_32-apple-watchos10.0", "group.app.norr.watch"],
    ];
    const source = join(root, "main.c");
    writeFileSync(source, "int main(void) { return 0; }\n");
    for (const [bundle, name, id, platform, target] of bundles) {
      mkdirSync(bundle, { recursive: true });
      const sdk = execFileSync("xcrun", ["--sdk", platform, "--show-sdk-path"], { encoding: "utf8" }).trim();
      writeFileSync(join(bundle, "Info.plist"), JSON.stringify({
        CFBundleExecutable: name,
        CFBundleIdentifier: id,
        CFBundleShortVersionString: bundle === app ? "0.2.0" : "0.1.0",
        CFBundleVersion: bundle === app ? "1020" : "1001",
        CFBundleSupportedPlatforms: [platform === "watchos" ? "WatchOS" : "iPhoneOS"],
        ...(bundle === watch ? { WKCompanionAppBundleIdentifier: "app.norr.ios" } : {}),
      }));
      execFileSync("plutil", ["-convert", "xml1", join(bundle, "Info.plist")]);
      writeFileSync(join(bundle, "embedded.mobileprovision"), "stale signing profile");
      execFileSync("xcrun", ["clang", "-target", target, "-isysroot", sdk, source, "-o", join(bundle, name)]);
    }
    assert.throws(() => verifyEmbeddedWatch(app, true), /CFBundleShortVersionString/);
    synchronizeEmbeddedVersions(app);
    assert.doesNotThrow(() => verifyEmbeddedWatch(app, true));
    for (const [bundle] of bundles) {
      assert.equal(execFileSync("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(bundle, "Info.plist")], { encoding: "utf8" }).trim(), "0.2.0");
      assert.equal(execFileSync("plutil", ["-extract", "CFBundleVersion", "raw", "-o", "-", join(bundle, "Info.plist")], { encoding: "utf8" }).trim(), "1020");
    }
    assert.throws(() => verifyEmbeddedWatch(app, false), /Incorrect watch platform/);
    execFileSync("plutil", ["-replace", "WKCompanionAppBundleIdentifier", "-string", "app.other", join(watch, "Info.plist")]);
    assert.throws(() => verifyEmbeddedWatch(app, true), /companion identifier/);
    execFileSync("plutil", ["-replace", "WKCompanionAppBundleIdentifier", "-string", "app.norr.ios", join(watch, "Info.plist")]);
    prepareIOSForResigning(app);
    for (const [bundle, , , , , group] of bundles) {
      assert.equal(existsSync(join(bundle, "embedded.mobileprovision")), false);
      const signature = spawnSync("codesign", ["--display", "--verbose=4", bundle], { encoding: "utf8" });
      assert.equal(signature.status, 0);
      assert.match(signature.stderr, /Signature=adhoc/);
      assert.match(signature.stderr, /TeamIdentifier=not set/);
      assert.doesNotMatch(signature.stderr, /^Authority=/m);
      const result = execFileSync("codesign", ["-d", "--entitlements", ":-", bundle]);
      const permissions = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", "-"], { input: result }));
      assert.deepEqual(permissions, { "com.apple.security.application-groups": [group] });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
