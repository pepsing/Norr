import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readBuildConfig } from "./build-config.mjs";
import { finalizeIOS } from "./finalize-ios.mjs";
import { finalizeMacOS } from "./finalize-macos.mjs";

const platform =
  process.argv[2] ?? (process.platform === "win32" ? "windows" : "macos");
if (!["macos", "windows", "android", "ios"].includes(platform)) {
  console.error("构建平台应为 macos、windows、android 或 ios。");
  process.exit(1);
}

const extraArgs = process.argv.slice(3);
const fieldTest = extraArgs.includes("--p4-field-test");
if (fieldTest && !(platform === "windows" || (platform === "ios" && extraArgs.includes("--device")))) throw new Error("P4 实测包支持 Windows 或 iOS 真机");
const polestar4Test = extraArgs.includes("--polestar4-test");
let configuration;
try {
  configuration = readBuildConfig(process.env, { requireXchanger: !fieldTest });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
if (polestar4Test && (fieldTest || !["macos", "windows", "ios"].includes(platform) || (platform === "ios" && !extraArgs.includes("--device")))) {
  console.error("P4 控制包支持 macOS、Windows 或 iOS 真机，不能同时选择旧实测模式。");
  process.exit(1);
}
if (polestar4Test && platform === "macos" && (!process.env.APPLE_SIGNING_IDENTITY || process.env.APPLE_SIGNING_IDENTITY === "-")) {
  console.error("Polestar 4 测试包需要通过 APPLE_SIGNING_IDENTITY 指定固定签名证书。");
  process.exit(1);
}
const device = platform === "ios" && extraArgs.includes("--device");
const args =
  platform === "android"
    ? ["android", "build", "--apk", "--target", "aarch64"]
    : platform === "ios"
      ? ["ios", "build", "--target", device ? "aarch64" : "aarch64-sim", "--no-sign", "--archive-only"]
      : ["build", "--bundles", platform === "windows" ? "nsis" : "app"];
if (platform === "windows") {
  args.push("--target", "x86_64-pc-windows-msvc");
  if (process.platform !== "win32") args.push("--runner", "cargo-xwin");
}
args.push(...extraArgs.filter((arg) => arg !== "--p4-field-test" && arg !== "--polestar4-test" && (platform !== "ios" || arg !== "--device")));
if (fieldTest) {
  args.push("--no-default-features", "--features", "p4-field-test");
  if (platform === "windows") args.push("--config", "src-tauri/tauri.p4-windows-test.conf.json");
}
if (polestar4Test) {
  args.push("--features", "polestar4-test");
  if (platform === "macos") args.push("--config", "src-tauri/tauri.polestar4.conf.json");
  if (platform === "windows") args.push("--config", "src-tauri/tauri.p4-windows-test.conf.json");
}
const cli = fileURLToPath(
  new URL("../../../node_modules/@tauri-apps/cli/tauri.js", import.meta.url),
);
const result = spawnSync(process.execPath, [cli, ...args], {
  stdio: "inherit",
  env: {
    ...process.env,
    ...(platform === "macos"
      ? { PATH: `/usr/bin:/bin:${process.env.PATH ?? ""}` }
      : {}),
    VITE_P4_FIELD_TEST: fieldTest ? "true" : polestar4Test ? platform : "false",
    ...configuration,
  },
});
if (result.error)
  console.error("构建启动失败。请检查 Tauri 和 Rust 开发环境。");
if (result.status === 0 && platform === "ios") finalizeIOS(device, fieldTest, polestar4Test);
if (result.status === 0 && platform === "macos") finalizeMacOS(extraArgs, { polestar4Test });
process.exit(result.status ?? 1);
