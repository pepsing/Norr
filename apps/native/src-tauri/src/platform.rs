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
        Ok(PathBuf::from(home)
            .join("Library/Application Support")
            .join(norr_vehicle_core::credentials::storage_namespace()))
    }
    #[cfg(target_os = "windows")]
    {
        let directory = std::env::var_os("LOCALAPPDATA").ok_or("无法定位 Windows 用户数据目录")?;
        Ok(PathBuf::from(directory).join(norr_vehicle_core::credentials::storage_namespace()))
    }
}

pub fn private_file(_options: &mut OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        _options.mode(0o600);
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "windows")))]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "macos")]
    fn macos_data_and_session_lock_follow_the_credential_namespace() {
        let directory = data_directory().unwrap();
        let expected = if cfg!(feature = "polestar4-test") {
            "app.norr.mac.polestar4"
        } else {
            "app.norr.mac"
        };
        assert_eq!(
            norr_vehicle_core::credentials::storage_namespace(),
            expected
        );
        assert!(directory.ends_with(Path::new("Application Support").join(expected)));
        assert!(directory
            .join("session.lock")
            .ends_with(Path::new(expected).join("session.lock")));
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn windows_p4_storage_is_separate_and_preserves_the_field_test_namespace() {
        let expected = if cfg!(any(feature = "p4-field-test", feature = "polestar4-test")) {
            "app.norr.windows.p4test"
        } else {
            "app.norr.windows"
        };
        let directory = data_directory().unwrap();
        assert_eq!(
            norr_vehicle_core::credentials::storage_namespace(),
            expected
        );
        assert_eq!(
            directory,
            PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap()).join(expected)
        );
        assert!(directory
            .join("session.lock")
            .ends_with(Path::new(expected).join("session.lock")));
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
        let title = if cfg!(any(feature = "p4-field-test", feature = "polestar4-test")) {
            w!("Norr 北行 · P4 实测")
        } else {
            w!("Norr 北行")
        };
        if let Ok(window) = FindWindowW(None, title) {
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

#[cfg(not(target_os = "windows"))]
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
}
