import { writeFileSync } from "node:fs";
import { nativeBuildConfig, serializeBuildConfig } from "./build-config.mjs";

try {
  const configuration = nativeBuildConfig(process.env);
  writeFileSync(new URL("../../../.env.secrets", import.meta.url), serializeBuildConfig(configuration), {
    mode: 0o600,
    flag: "wx",
  });
} catch {
  console.error("无法写入构建配置。请检查环境变量，并确认 .env.secrets 尚不存在。");
  process.exit(1);
}
