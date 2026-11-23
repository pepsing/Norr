import { cpSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function finalizeMacOS(args, { polestar4Test = false } = {}) {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const targetIndex = args.indexOf("--target");
  const target = targetIndex >= 0 ? args[targetIndex + 1] : process.env.CARGO_BUILD_TARGET;
  const profile = args.includes("--debug") ? "debug" : "release";
  const targetDirectory = resolve(root, process.env.CARGO_TARGET_DIR || "target");
  const app = resolve(targetDirectory, target || "", profile, `bundle/macos/${polestar4Test ? "Norr P4" : "Norr"}.app`);
  const info = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", `${app}/Contents/Info.plist`]));
  if (polestar4Test) {
    if (info.CFBundleIdentifier !== "app.norr.mac.polestar4") {
      throw new Error("Polestar 4 测试包标识不匹配。");
    }
    const identity = process.env.APPLE_SIGNING_IDENTITY;
    if (!identity || identity === "-") {
      throw new Error("独立测试包需要通过 APPLE_SIGNING_IDENTITY 指定固定签名证书，以保留钥匙串访问授权。");
    }
    execFileSync("codesign", ["--force", "--sign", identity, app], { stdio: "inherit" });
    execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
    console.log(`Polestar 4 独立测试包已签名：${app}`);
    return;
  }
  const architectures = execFileSync("lipo", ["-archs", `${app}/Contents/MacOS/${info.CFBundleExecutable}`], { encoding: "utf8" }).trim();
  const derivedData = resolve(targetDirectory, "macos-widgets", architectures.replaceAll(" ", "-"));
  const project = fileURLToPath(new URL("../src-tauri/macos/NorrWidgets.xcodeproj", import.meta.url));
  execFileSync("xcodebuild", [
    "-project", project, "-scheme", "NorrWidgets", "-configuration", "Release",
    "-derivedDataPath", derivedData, "-sdk", "macosx", "build",
    `ARCHS=${architectures}`, "ONLY_ACTIVE_ARCH=NO", "CODE_SIGN_IDENTITY=-",
    `MARKETING_VERSION=${info.CFBundleShortVersionString}`,
    `CURRENT_PROJECT_VERSION=${info.CFBundleVersion}`,
  ], { stdio: "inherit" });
  const destination = `${app}/Contents/PlugIns/NorrWidgets.appex`;
  mkdirSync(dirname(destination), { recursive: true });
  rmSync(destination, { recursive: true, force: true });
  cpSync(`${derivedData}/Build/Products/Release/NorrWidgets.appex`, destination, { recursive: true });
  execFileSync("codesign", ["--force", "--sign", "-", "--preserve-metadata=entitlements,flags", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  console.log(`macOS 小组件已打包：${destination}`);
}
