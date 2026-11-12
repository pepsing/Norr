import { cpSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function finalizeIOSSimulator() {
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
  if (!info.CFBundleSupportedPlatforms?.includes("iPhoneSimulator")) return;

  const directory = fileURLToPath(
    new URL("../../../target/ios/", import.meta.url),
  );
  const app = `${directory}Norr.app`;
  const architecture = execFileSync("/usr/bin/lipo", ["-archs", `${source}/Norr`], {
    encoding: "utf8",
  }).trim().replaceAll(" ", "-");
  const archive = `${directory}Norr_${info.CFBundleShortVersionString}_ios-${architecture}-simulator.zip`;
  mkdirSync(directory, { recursive: true });
  rmSync(app, { recursive: true, force: true });
  cpSync(source, app, { recursive: true });
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", app], {
    stdio: "inherit",
  });
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", app], {
    stdio: "inherit",
  });
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, archive], {
    stdio: "inherit",
  });
  console.log(`iOS 模拟器应用：${app}\n模拟器压缩包：${archive}`);
}
