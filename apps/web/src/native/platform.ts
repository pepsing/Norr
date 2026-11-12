const platform = (window as Window & { __NORR_PLATFORM__?: string })
  .__NORR_PLATFORM__;

export const isWindows = platform === "windows";
export const isAndroid = platform === "android";
export const isIOS = platform === "ios";
export const isMobile = isAndroid || isIOS;
export const desktopName = isAndroid
  ? "Android"
  : isIOS
    ? "iOS"
    : isWindows
      ? "Windows"
      : "macOS";
export const credentialStorage = isAndroid
  ? "Android Keystore 加密存储"
  : isIOS
    ? "iOS 钥匙串"
    : isWindows
      ? "Windows 账户加密存储"
      : "macOS 钥匙串";
