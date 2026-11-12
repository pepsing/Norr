import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

let signingKey = process.env.NORR_POLESTAR_CN_SIGNING_KEY?.trim();
if (!signingKey) {
  try {
    signingKey = parseEnv(
      readFileSync(new URL("../../../.env.secrets", import.meta.url), "utf8"),
    ).NORR_POLESTAR_CN_SIGNING_KEY?.trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
if (!signingKey) {
  console.error("iOS 构建缺少 NORR_POLESTAR_CN_SIGNING_KEY。");
  process.exit(1);
}
const cli = fileURLToPath(
  new URL("../../../node_modules/@tauri-apps/cli/tauri.js", import.meta.url),
);
const result = spawnSync(
  process.execPath,
  [cli, "ios", "xcode-script", ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: { ...process.env, NORR_POLESTAR_CN_SIGNING_KEY: signingKey },
  },
);
if (result.error) console.error("iOS Rust 构建未能启动。");
process.exit(result.status ?? 1);
