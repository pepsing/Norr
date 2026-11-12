use super::Result;
use std::{io::Write, path::PathBuf};

#[cfg(target_os = "macos")]
use std::ffi::{CStr, CString};

#[cfg(target_os = "macos")]
extern "C" {
    fn norr_save_path(name: *const std::ffi::c_char) -> *mut std::ffi::c_char;
    fn norr_free_string(value: *mut std::ffi::c_char);
    fn norr_open_path() -> *mut std::ffi::c_char;
}

#[cfg(target_os = "macos")]
pub fn open_path() -> Result<Option<PathBuf>> {
    let selected = unsafe { norr_open_path() };
    if selected.is_null() {
        return Ok(None);
    }
    let path = unsafe { CStr::from_ptr(selected) }
        .to_str()
        .map(PathBuf::from)
        .map_err(|_| "文件路径无效");
    unsafe {
        norr_free_string(selected);
    }
    Ok(Some(path?))
}

#[cfg(target_os = "macos")]
fn save_path(format: &str) -> Result<Option<PathBuf>> {
    let name = CString::new(format!("norr-history.{format}")).map_err(|_| "文件名无效")?;
    let selected = unsafe { norr_save_path(name.as_ptr()) };
    if selected.is_null() {
        return Ok(None);
    }
    let path = unsafe { CStr::from_ptr(selected) }
        .to_str()
        .map(PathBuf::from)
        .map_err(|_| "文件路径无效");
    unsafe {
        norr_free_string(selected);
    }
    Ok(Some(path?))
}

#[cfg(target_os = "windows")]
pub fn open_path() -> Result<Option<PathBuf>> {
    Ok(rfd::FileDialog::new()
        .set_title("恢复 Norr 历史备份")
        .add_filter("Norr 备份", &["json"])
        .pick_file())
}

#[cfg(target_os = "windows")]
fn save_path(format: &str) -> Result<Option<PathBuf>> {
    Ok(rfd::FileDialog::new()
        .set_title("导出车辆记录")
        .set_file_name(format!("norr-history.{format}"))
        .add_filter("车辆记录", &[format])
        .save_file())
}

#[cfg(desktop)]
pub fn save(bytes: Vec<u8>, format: &str) -> Result<bool> {
    let Some(path) = save_path(format)? else {
        return Ok(false);
    };
    let temporary = path.with_file_name(format!(".norr-export-{}", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        crate::platform::private_file(&mut options);
        let mut file = options.open(&temporary).map_err(|_| "无法创建导出文件")?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "导出文件写入失败")?;
        drop(file);
        std::fs::rename(&temporary, &path).map_err(|_| "导出文件保存失败")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result.map(|_| true)
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn open_path() -> Result<Option<PathBuf>> {
    #[derive(serde::Deserialize)]
    struct Selected {
        path: Option<PathBuf>,
    }
    crate::mobile::call::<Selected>("openBackup", serde_json::json!({})).map(|result| result.path)
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn save(bytes: Vec<u8>, format: &str) -> Result<bool> {
    #[derive(serde::Deserialize)]
    struct Saved {
        saved: bool,
    }
    let path =
        crate::platform::data_directory()?.join(format!("export-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        crate::platform::private_file(&mut options);
        let mut file = options.open(&path).map_err(|_| "无法准备导出文件")?;
        file.write_all(&bytes).map_err(|_| "无法写入导出内容")?;
        drop(file);
        crate::mobile::call::<Saved>(
            "saveHistory",
            serde_json::json!({"path":path,"format":format}),
        )
        .map(|result| result.saved)
    })();
    let _ = std::fs::remove_file(path);
    result
}
