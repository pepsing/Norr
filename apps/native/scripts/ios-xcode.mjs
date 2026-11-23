import { spawnSync } from "node:child_process";
import { readBuildConfig } from "./build-config.mjs";
import { fileURLToPath } from "node:url";

let configuration;
try {
  configuration = readBuildConfig(process.env, {
    requireXchanger: process.env.VITE_P4_FIELD_TEST !== "true",
  });
} catch (error) {
  console.error(error.message);
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
    env: { ...process.env, ...configuration },
  },
);
if (result.error) console.error("iOS Rust 构建未能启动。");
process.exit(result.status ?? 1);
