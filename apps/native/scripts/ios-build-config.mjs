import { nativeBuildConfig } from "./build-config.mjs";

export function iosBuildConfig(environment, fileText) {
  return nativeBuildConfig(environment, fileText);
}
