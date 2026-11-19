import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function finalizeIOS(device = false) {
  const source = fileURLToPath(
    new URL(
      "../src-tauri/gen/apple/build/norr_iOS.xcarchive/Products/Applications/Norr.app",
      import.meta.url,
    ),
  );
  const info = JSON.parse(
    execFileSync(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", `${source}/Info.plist`],
      { encoding: "utf8" },
    ),
  );
  const platform = device ? "iPhoneOS" : "iPhoneSimulator";
  if (!info.CFBundleSupportedPlatforms?.includes(platform)) {
    throw new Error(`Expected ${platform} archive`);
  }
  verifyIOSWidgetCommand(`${source}/${info.CFBundleExecutable}`);
  verifyIOSSiriShortcuts(source, info.CFBundleExecutable);
  synchronizeEmbeddedVersions(source);
  verifyEmbeddedWatch(source, device);

  const directory = fileURLToPath(
    new URL("../../../target/ios/", import.meta.url),
  );
  const app = `${directory}Norr.app`;
  const architecture = execFileSync("/usr/bin/lipo", ["-archs", `${source}/Norr`], {
    encoding: "utf8",
  }).trim().replaceAll(" ", "-");
  if (device) {
    if (architecture !== "arm64") throw new Error("Expected ARM64 iOS device app");
    const buildInfo = execFileSync("/usr/bin/xcrun", ["vtool", "-show-build", `${source}/Norr`], {
      encoding: "utf8",
    });
    if (!/^\s*platform IOS\s*$/m.test(buildInfo)) {
      throw new Error("Expected Mach-O built for iOS devices");
    }
    packageUnsignedIPAs(source, directory, info.CFBundleShortVersionString);
    return;
  }
  const archive = `${directory}Norr_${info.CFBundleShortVersionString}_ios-${architecture}-simulator.zip`;
  mkdirSync(directory, { recursive: true });
  rmSync(app, { recursive: true, force: true });
  cpSync(source, app, { recursive: true });
  prepareIOSForResigning(app);
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, archive], {
    stdio: "inherit",
  });
  console.log(`iOS 模拟器应用：${app}\n模拟器压缩包：${archive}`);
}

function verifyIOSSiriShortcuts(app, executable) {
  const metadata = JSON.parse(readFileSync(`${app}/Metadata.appintents/extract.actionsdata`, "utf8"));
  const localized = JSON.parse(execFileSync("/usr/bin/plutil", [
    "-convert", "json", "-o", "-", `${app}/zh-Hans.lproj/AppShortcuts.strings`,
  ], { encoding: "utf8" }));
  const intentNames = [
    "GetVehicleEnergyIntent", "GetVehicleLockStateIntent", "LockVehicleIntent",
    "StartVehicleClimateIntent", "StopVehicleClimateIntent",
  ];
  for (const name of intentNames) {
    const action = metadata.actions?.[name];
    const shortcut = metadata.autoShortcuts?.find(item => item.actionIdentifier === name);
    if (!action || !action.authenticationPolicy || action.openAppWhenRun) {
      throw new Error(`Missing background Siri action or authentication policy: ${name}`);
    }
    if (!shortcut?.phraseTemplates?.length ||
        !shortcut.phraseTemplates.every(phrase => localized[phrase.key]?.includes("${applicationName}"))) {
      throw new Error(`Missing Chinese Siri phrase for ${name}`);
    }
  }
  const selectors = execFileSync("/usr/bin/xcrun", [
    "otool", "-v", "-s", "__TEXT", "__objc_methname", `${app}/${executable}`,
  ], { encoding: "utf8" });
  if (!/^\s*[0-9a-f]+\s+refreshShortcuts\s*$/m.test(selectors)) {
    throw new Error("Missing linked Siri shortcut registration");
  }
}

export function verifyIOSWidgetCommand(executable) {
  const selectors = execFileSync("/usr/bin/xcrun", [
    "otool", "-v", "-s", "__TEXT", "__objc_methname", executable,
  ], { encoding: "utf8" });
  if (!/^\s*[0-9a-f]+\s+updateWidgets:error:\s*$/m.test(selectors)) {
    throw new Error("Missing iOS widget command updateWidgets:error: in linked app");
  }
}

export function prepareIOSForResigning(app) {
  const nestedCode = readdirSync(app, { recursive: true }).filter(
    (path) => [".dylib", ".framework", ".appex", ".app"].some((suffix) => path.endsWith(suffix)),
  ).sort((a, b) => b.split("/").length - a.split("/").length);
  const extension = `${app}/PlugIns/NorrWidgets.appex`;
  const entitlements = fileURLToPath(new URL("../src-tauri/ios/Widgets/Widgets.entitlements", import.meta.url));
  const watch = `${app}/Watch/NorrWatch.app`;
  const watchExtension = `${watch}/PlugIns/NorrWatchWidgets.appex`;
  const watchEntitlements = fileURLToPath(new URL("../src-tauri/watch/Shared/Watch.entitlements", import.meta.url));
  for (const code of [...nestedCode.map((path) => `${app}/${path}`), app]) {
    if (!code.endsWith(".dylib")) rmSync(`${code}/embedded.mobileprovision`, { force: true });
    const args = ["--force", "--sign", "-", "--timestamp=none"];
    // AltStore discovers App Groups from code-signing entitlements, even before personal signing.
    if (code === app || code === extension) args.push("--entitlements", entitlements);
    if (code === watch || code === watchExtension) args.push("--entitlements", watchEntitlements);
    execFileSync("/usr/bin/codesign", [...args, code], { stdio: "pipe" });
  }
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "pipe" });
  const bundles = [[app, "group.app.norr.widgets"], [extension, "group.app.norr.widgets"]];
  if (existsSync(watch)) bundles.push([watch, "group.app.norr.watch"], [watchExtension, "group.app.norr.watch"]);
  for (const [code, group] of bundles) {
    const xml = execFileSync("/usr/bin/codesign", ["--display", "--entitlements", ":-", code]);
    const permissions = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
      input: xml, encoding: "utf8",
    }));
    if (JSON.stringify(permissions["com.apple.security.application-groups"]) !== JSON.stringify([group])) {
      throw new Error(`Missing widget App Group in ${code}`);
    }
  }
}

export function synchronizeEmbeddedVersions(app) {
  const parent = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", `${app}/Info.plist`], { encoding: "utf8" }));
  const bundles = readdirSync(app, { recursive: true }).filter(path => path.endsWith(".app") || path.endsWith(".appex"));
  for (const key of ["CFBundleShortVersionString", "CFBundleVersion"]) {
    if (typeof parent[key] !== "string" || !parent[key]) throw new Error(`Missing parent ${key}`);
    for (const bundle of bundles) {
      execFileSync("/usr/bin/plutil", ["-replace", key, "-string", parent[key], `${app}/${bundle}/Info.plist`]);
    }
  }
}

export function verifyEmbeddedWatch(app, device) {
  const watch = `${app}/Watch/NorrWatch.app`;
  const readInfo = (bundle) => JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", `${bundle}/Info.plist`], { encoding: "utf8" }));
  const parent = readInfo(app);
  for (const bundle of [watch, `${watch}/PlugIns/NorrWatchWidgets.appex`]) {
    const info = readInfo(bundle);
    if (!info.CFBundleSupportedPlatforms?.includes(device ? "WatchOS" : "WatchSimulator")) {
      throw new Error(`Incorrect watch platform in ${bundle}`);
    }
    if (!info.CFBundleIdentifier.startsWith(`${parent.CFBundleIdentifier}.`)) {
      throw new Error(`Watch identifier does not match companion in ${bundle}`);
    }
    for (const key of ["CFBundleShortVersionString", "CFBundleVersion"]) {
      if (!parent[key] || info[key] !== parent[key]) throw new Error(`Watch ${key} does not match companion in ${bundle}`);
    }
    const build = execFileSync("/usr/bin/xcrun", ["vtool", "-show-build", `${bundle}/${info.CFBundleExecutable}`], { encoding: "utf8" });
    const platform = device ? /^\s*platform WATCHOS\s*$/m : /^\s*platform WATCHOSSIMULATOR\s*$/m;
    if (!platform.test(build)) throw new Error(`Incorrect watch Mach-O platform in ${bundle}`);
  }
  if (readInfo(watch).WKCompanionAppBundleIdentifier !== parent.CFBundleIdentifier) {
    throw new Error("Watch companion identifier does not match iOS app");
  }
}

function packageUnsignedIPAs(source, directory, version) {
  mkdirSync(directory, { recursive: true });
  const staging = mkdtempSync(`${directory}.unsigned-`);
  const variants = ["unsigned.ipa", "no-watch-unsigned.ipa"];
  try {
    const payload = `${staging}/Payload`;
    const app = `${payload}/Norr.app`;
    mkdirSync(payload);
    cpSync(source, app, { recursive: true });
    for (const variant of variants) {
      if (variant === "no-watch-unsigned.ipa") {
        rmSync(`${app}/Watch`, { recursive: true });
      }
      const archive = `${staging}/${variant}`;
      prepareIOSForResigning(app);
      execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", "--norsrc", payload, archive]);
      execFileSync("/usr/bin/unzip", ["-tq", archive]);
    }
    for (const variant of variants) {
      const archive = `${directory}Norr_${version}_ios-arm64-${variant}`;
      renameSync(`${staging}/${variant}`, archive);
      console.log(`待个人签名 iOS IPA：${archive}`);
    }
    console.log("已使用 ad-hoc 签名保留小组件权限声明，安装前需使用有效证书与描述文件重新签名。");
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
