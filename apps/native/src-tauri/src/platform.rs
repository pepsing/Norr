use crate::Result;
use std::{
    fs::OpenOptions,
    path::{Path, PathBuf},
};

pub fn data_directory() -> Result<PathBuf> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        crate::mobile::data_directory()
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME").ok_or("无法定位用户数据目录")?;
        Ok(PathBuf::from(home).join("Library/Application Support/app.norr.mac"))
    }
    #[cfg(target_os = "windows")]
    {
        let directory = std::env::var_os("LOCALAPPDATA").ok_or("无法定位 Windows 用户数据目录")?;
        Ok(PathBuf::from(directory).join("app.norr.windows"))
    }
}

pub fn private_file(_options: &mut OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        _options.mode(0o600);
    }
}

pub fn private_path(_path: &Path, _mode: u32) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(_path, std::fs::Permissions::from_mode(_mode))
            .map_err(|_| "无法设置本机文件权限")?;
    }
    Ok(())
}

pub fn private_directory(path: &Path) -> Result<()> {
    private_path(path, 0o700)
}

#[cfg(desktop)]
pub fn show_running_window() -> bool {
    #[cfg(target_os = "windows")]
    unsafe {
        use windows::{
            core::w,
            Win32::UI::WindowsAndMessaging::{
                FindWindowW, SetForegroundWindow, ShowWindow, SW_RESTORE,
            },
        };
        if let Ok(window) = FindWindowW(None, w!("Norr 北行")) {
            let _ = ShowWindow(window, SW_RESTORE);
            let _ = SetForegroundWindow(window);
            return true;
        }
    }
    false
}

pub fn open_url(url: &str) -> Result<()> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    crate::mobile::call::<()>("openUrl", serde_json::json!({"url":url}))?;
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("/usr/bin/open")
            .arg(url)
            .status()
            .map_err(|_| "无法打开链接")?;
        if !status.success() {
            return Err("无法打开链接".into());
        }
    }
    #[cfg(target_os = "windows")]
    {
        use windows::{
            core::HSTRING,
            Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
        };
        let target = HSTRING::from(url);
        let result = unsafe {
            ShellExecuteW(
                None,
                windows::core::w!("open"),
                &target,
                None,
                None,
                SW_SHOWNORMAL,
            )
        };
        if result.0 as isize <= 32 {
            return Err("无法打开链接".into());
        }
    }
    Ok(())
}

pub fn authenticate(_window: &tauri::WebviewWindow) -> Result<bool> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        #[derive(serde::Deserialize)]
        struct Answer {
            authorized: bool,
        }
        crate::mobile::call::<Answer>("confirmCredential", serde_json::json!({}))
            .map(|answer| answer.authorized)
    }
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn norr_authenticate() -> bool;
        }
        Ok(unsafe { norr_authenticate() })
    }
    #[cfg(target_os = "windows")]
    {
        use windows::{
            core::{factory, HSTRING},
            Security::Credentials::UI::{
                UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
            },
            Win32::{Foundation::HWND, System::WinRT::IUserConsentVerifierInterop},
        };
        let _apartment =
            crate::desktop::Apartment::new().map_err(|_| "Windows 身份验证初始化失败")?;
        let availability = UserConsentVerifier::CheckAvailabilityAsync()
            .and_then(|operation| operation.join())
            .map_err(|_| "无法读取 Windows Hello 状态")?;
        if availability != UserConsentVerifierAvailability::Available {
            return Err(
                "请先在 Windows 设置中配置 Windows Hello PIN 或生物识别，再确认车辆操作".into(),
            );
        }
        let hwnd = _window.hwnd().map_err(|_| "无法定位身份验证窗口")?;
        let interop = factory::<UserConsentVerifier, IUserConsentVerifierInterop>()
            .map_err(|_| "Windows 身份验证不可用")?;
        let operation: windows_future::IAsyncOperation<UserConsentVerificationResult> = unsafe {
            interop.RequestVerificationForWindowAsync(
                HWND(hwnd.0),
                &HSTRING::from("确认 Norr 的车辆操作"),
            )
        }
        .map_err(|_| "无法打开 Windows 身份验证")?;
        operation
            .join()
            .map(|result| result == UserConsentVerificationResult::Verified)
            .map_err(|_| "Windows 身份验证未完成".into())
    }
}
