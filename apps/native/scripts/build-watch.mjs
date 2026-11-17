import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const projectDirectory = fileURLToPath(new URL("../src-tauri/gen/apple", import.meta.url));
const device = process.argv.includes("--device");
const generation = spawnSync("xcodegen", ["generate"], { cwd: projectDirectory, stdio: "inherit" });
if (generation.status !== 0) process.exit(generation.status ?? 1);
const result = spawnSync("xcodebuild", [
  "-project", `${projectDirectory}/norr.xcodeproj`, "-scheme", "NorrWatch",
  "-configuration", "debug", "-sdk", device ? "watchos" : "watchsimulator",
  "-destination", device ? "generic/platform=watchOS" : "generic/platform=watchOS Simulator",
  "-derivedDataPath", `${root}/target/watch`, "CODE_SIGNING_ALLOWED=NO", "build",
], { cwd: root, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
const product = `${root}/target/watch/Build/Products/debug-${device ? "watchos" : "watchsimulator"}/NorrWatch.app`;
const entitlements = `${root}/apps/native/src-tauri/watch/Shared/Watch.entitlements`;
for (const bundle of [`${product}/PlugIns/NorrWatchWidgets.appex`, product]) {
  execFileSync("codesign", ["--force", "--sign", "-", "--entitlements", entitlements, bundle], { stdio: "inherit" });
}
execFileSync("codesign", ["--verify", "--deep", "--strict", product], { stdio: "inherit" });
console.log(`${device ? "待开发签名 Watch App" : "Watch 模拟器 App"}：${product}`);
