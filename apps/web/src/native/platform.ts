const platform = typeof window === "undefined"
  ? undefined
  : (window as Window & { __NORR_PLATFORM__?: string }).__NORR_PLATFORM__;

export const isWindows = platform === "windows";
export const isAndroid = platform === "android";
export const isIOS = platform === "ios";
export const isHarmonyOS = platform === "harmonyos";
export const supportsWidgets = ["android", "ios", "macos"].includes(platform ?? "");
export const isMobile = isAndroid || isIOS || isHarmonyOS;
export const desktopName = isHarmonyOS
  ? "HarmonyOS"
  : isAndroid
  ? "Android"
  : isIOS
    ? "iOS"
    : isWindows
      ? "Windows"
      : "macOS";
export const credentialStorage = isHarmonyOS
  ? "鸿蒙 Asset Store 保护的加密存储"
  : isAndroid
  ? "Android Keystore 加密存储"
  : isIOS
    ? "iOS 钥匙串"
    : isWindows
      ? "Windows 账户加密存储"
      : "macOS 钥匙串";
