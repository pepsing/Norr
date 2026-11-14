import { cpSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
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
    packageUnsignedIPA(source, directory, info.CFBundleShortVersionString);
    return;
  }
  const archive = `${directory}Norr_${info.CFBundleShortVersionString}_ios-${architecture}-simulator.zip`;
  mkdirSync(directory, { recursive: true });
  rmSync(app, { recursive: true, force: true });
  cpSync(source, app, { recursive: true });
  const extension = `${app}/PlugIns/NorrWidgets.appex`;
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", extension], {
    stdio: "inherit",
  });
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", app], {
    stdio: "inherit",
  });
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], {
    stdio: "inherit",
  });
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, archive], {
    stdio: "inherit",
  });
  console.log(`iOS 模拟器应用：${app}\n模拟器压缩包：${archive}`);
}

export function prepareIOSForResigning(app) {
  const nestedCode = readdirSync(app, { recursive: true }).filter(
    (path) => path.endsWith(".dylib") || path.endsWith(".framework") || path.endsWith(".appex"),
  ).sort((a, b) => b.split("/").length - a.split("/").length);
  const extension = `${app}/PlugIns/NorrWidgets.appex`;
  const entitlements = fileURLToPath(new URL("../src-tauri/ios/Widgets/Widgets.entitlements", import.meta.url));
  for (const code of [...nestedCode.map((path) => `${app}/${path}`), app]) {
    if (!code.endsWith(".dylib")) rmSync(`${code}/embedded.mobileprovision`, { force: true });
    const args = ["--force", "--sign", "-", "--timestamp=none"];
    // AltStore discovers App Groups from code-signing entitlements, even before personal signing.
    if (code === app || code === extension) args.push("--entitlements", entitlements);
    execFileSync("/usr/bin/codesign", [...args, code], { stdio: "pipe" });
  }
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "pipe" });
  for (const code of [app, extension]) {
    const xml = execFileSync("/usr/bin/codesign", ["--display", "--entitlements", ":-", code]);
    const permissions = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
      input: xml, encoding: "utf8",
    }));
    if (JSON.stringify(permissions["com.apple.security.application-groups"]) !== JSON.stringify(["group.app.norr.widgets"])) {
      throw new Error(`Missing widget App Group in ${code}`);
    }
  }
}

function packageUnsignedIPA(source, directory, version) {
  mkdirSync(directory, { recursive: true });
  const staging = mkdtempSync(`${directory}.unsigned-`);
  const archive = `${directory}Norr_${version}_ios-arm64-unsigned.ipa`;
  try {
    const payload = `${staging}/Payload`;
    const app = `${payload}/Norr.app`;
    mkdirSync(payload);
    cpSync(source, app, { recursive: true });
    prepareIOSForResigning(app);
    execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", "--norsrc", payload, `${staging}/unsigned.ipa`]);
    execFileSync("/usr/bin/unzip", ["-tq", `${staging}/unsigned.ipa`]);
    renameSync(`${staging}/unsigned.ipa`, archive);
    console.log(`待个人签名 iOS IPA：${archive}\n已使用 ad-hoc 签名保留小组件权限声明，安装前需使用有效证书与描述文件重新签名。`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
