import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const configurationKeys = [
  "NORR_POLESTAR_CN_SIGNING_KEY",
  "NORR_XCHANGER_APP_SECRET",
  "NORR_P4_PARTNER_CLIENT_ID",
];

export function nativeBuildConfig(environment, fileText = "", { requireXchanger = false } = {}) {
  const local = parseEnv(fileText);
  const configuration = {};
  for (const key of configurationKeys) {
    const value = environment[key]?.trim() || local[key]?.trim();
    if (value) configuration[key] = value;
  }
  const required = ["NORR_POLESTAR_CN_SIGNING_KEY"];
  if (requireXchanger) required.push("NORR_XCHANGER_APP_SECRET");
  for (const key of required) {
    if (!configuration[key]) {
      throw new Error(`构建缺少 ${key}，请通过环境变量或仓库根目录 .env.secrets 提供。`);
    }
  }
  return configuration;
}

export function readBuildConfig(environment = process.env, options) {
  let fileText = "";
  try {
    fileText = readFileSync(new URL("../../../.env.secrets", import.meta.url), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("无法读取本地构建配置。请检查 .env.secrets 权限。");
  }
  return nativeBuildConfig(environment, fileText, options);
}

export function serializeBuildConfig(configuration) {
  const text = configurationKeys
    .filter(key => configuration[key])
    .map(key => `${key}=${JSON.stringify(configuration[key])}\n`)
    .join("");
  const parsed = parseEnv(text);
  if (configurationKeys.some(key => configuration[key] && parsed[key] !== configuration[key])) {
    throw new Error("构建配置无法保存为 dotenv 格式。");
  }
  return text;
}
