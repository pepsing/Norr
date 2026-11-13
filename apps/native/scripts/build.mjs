import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { finalizeIOS } from "./finalize-ios.mjs";

const platform =
  process.argv[2] ?? (process.platform === "win32" ? "windows" : "macos");
if (!["macos", "windows", "android", "ios"].includes(platform)) {
  console.error("构建平台应为 macos、windows、android 或 ios。");
  process.exit(1);
}

let signingKey = process.env.NORR_POLESTAR_CN_SIGNING_KEY?.trim();
if (!signingKey) {
  try {
    const configuration = parseEnv(
      readFileSync(new URL("../../../.env.secrets", import.meta.url), "utf8"),
    );
    signingKey = configuration.NORR_POLESTAR_CN_SIGNING_KEY?.trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
if (!signingKey) {
  console.error(
    "构建登录版本需要 NORR_POLESTAR_CN_SIGNING_KEY。请通过环境变量或仓库根目录 .env.secrets 提供。",
  );
  process.exit(1);
}
const extraArgs = process.argv.slice(3);
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
args.push(...extraArgs.filter((arg) => platform !== "ios" || arg !== "--device"));
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
    NORR_POLESTAR_CN_SIGNING_KEY: signingKey,
  },
});
if (result.error)
  console.error("构建启动失败。请检查 Tauri 和 Rust 开发环境。");
if (result.status === 0 && platform === "ios") finalizeIOS(device);
process.exit(result.status ?? 1);
