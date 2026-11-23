#[cfg(not(target_os = "android"))]
use crate::credentials;
use crate::Result;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::{fs::File, fs::OpenOptions, path::Path, path::PathBuf};

#[cfg(any(target_os = "android", test))]
static ANDROID_DIRECTORY: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

#[cfg(any(target_os = "android", test))]
pub fn initialize_android_directory(directory: PathBuf) -> Result<()> {
    if !directory.is_absolute() {
        return Err("P4 Android 应用数据目录无效".into());
    }
    ANDROID_DIRECTORY
        .set(directory)
        .map_err(|_| "P4 Android 应用数据目录重复初始化".into())
}

#[cfg(any(target_os = "android", test))]
fn android_directory() -> Result<PathBuf> {
    ANDROID_DIRECTORY
        .get()
        .cloned()
        .ok_or_else(|| "P4 Android 应用数据目录尚未就绪".into())
}

fn directory() -> Result<PathBuf> {
    #[cfg(target_os = "android")]
    {
        android_directory()
    }
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        Ok(
            PathBuf::from(std::env::var_os("HOME").ok_or("用户目录不可用")?)
                .join("Library/Application Support")
                .join(credentials::storage_namespace()),
        )
    }
    #[cfg(target_os = "windows")]
    {
        Ok(
            PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("Windows 用户目录不可用")?)
                .join(credentials::storage_namespace()),
        )
    }
}

pub(super) fn lock() -> Result<File> {
    lock_in(&directory()?)
}

fn lock_in(directory: &Path) -> Result<File> {
    std::fs::create_dir_all(directory).map_err(|_| "无法创建 P4 会话目录")?;
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    // Desktop probes must keep using the same lock as the application.
    let lock = options
        .open(directory.join("geely-probe.lock"))
        .map_err(|_| "无法访问 P4 会话锁")?;
    try_lock(&lock).map_err(|error| {
        if error.kind() == std::io::ErrorKind::WouldBlock {
            "P4 会话正在更新，请稍后刷新".into()
        } else {
            format!("无法锁定 P4 会话（{error}）")
        }
    })?;
    Ok(lock)
}

#[cfg(target_os = "android")]
fn try_lock(file: &File) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    // Android's std file locking is unsupported; flock releases when File closes.
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(target_os = "android"))]
fn try_lock(file: &File) -> std::io::Result<()> {
    file.try_lock().map_err(|error| match error {
        std::fs::TryLockError::WouldBlock => std::io::ErrorKind::WouldBlock.into(),
        std::fs::TryLockError::Error(error) => error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn android_without_home_uses_app_directory_and_keeps_exclusive_lock() {
        const CHILD: &str = "NORR_ANDROID_DIRECTORY_TEST";
        if std::env::var_os(CHILD).is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "geely::storage::tests::android_without_home_uses_app_directory_and_keeps_exclusive_lock",
                    "--nocapture",
                ])
                .env_remove("HOME")
                .env(CHILD, "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed;"));
            return;
        }
        assert!(std::env::var_os("HOME").is_none());
        assert!(android_directory().unwrap_err().contains("尚未就绪"));
        assert!(initialize_android_directory(PathBuf::from("relative/files")).is_err());
        let root = std::env::temp_dir().join(format!("norr-android-{}", uuid::Uuid::new_v4()));
        let app_files = root.join("北行 files");
        initialize_android_directory(app_files.clone()).unwrap();
        assert_eq!(android_directory().unwrap(), app_files);
        #[cfg(target_os = "android")]
        let first = lock().unwrap();
        #[cfg(not(target_os = "android"))]
        let first = lock_in(&android_directory().unwrap()).unwrap();
        assert!(app_files.join("geely-probe.lock").is_file());
        assert!(!app_files.join("Library").exists());
        assert!(lock_in(&app_files).unwrap_err().contains("会话正在更新"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(app_files.join("geely-probe.lock"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        drop(first);
        drop(lock_in(&app_files).unwrap());
        assert!(initialize_android_directory(root.join("other-account")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
