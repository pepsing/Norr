use crate::Result;
use std::{io::Write, path::PathBuf};
use windows::{
    core::w,
    Win32::{
        Foundation::{LocalFree, HLOCAL},
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    },
};
use zeroize::Zeroizing;

fn path(service: &str, account: &str) -> Result<PathBuf> {
    let directory = std::env::var_os("LOCALAPPDATA").ok_or("无法定位 Windows 用户数据目录")?;
    Ok(PathBuf::from(directory)
        .join(service)
        .join("credentials")
        .join(format!("{account}.dpapi")))
}

fn protect(bytes: &[u8], encrypt: bool) -> Result<Zeroizing<Vec<u8>>> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len().try_into().map_err(|_| "凭据内容过大")?,
        pbData: bytes.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // DPAPI binds the encrypted file to the current Windows account.
    unsafe {
        let result = if encrypt {
            CryptProtectData(
                &input,
                w!("Norr"),
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        result.map_err(|error| format!("Windows 凭据保护失败（{}）", error.code()))?;
        let result = Zeroizing::new(
            std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec(),
        );
        std::ptr::write_bytes(output.pbData, 0, output.cbData as usize);
        LocalFree(Some(HLOCAL(output.pbData.cast())));
        Ok(result)
    }
}

pub(super) fn read(service: &str, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>> {
    match std::fs::read(path(service, account)?) {
        Ok(bytes) => protect(&bytes, false).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("无法读取 Windows 本机凭据".into()),
    }
}

pub(super) fn write(service: &str, account: &str, bytes: &[u8]) -> Result<()> {
    let encrypted = protect(bytes, true)?;
    let path = path(service, account)?;
    std::fs::create_dir_all(path.parent().ok_or("凭据目录无效")?)
        .map_err(|_| "无法创建凭据目录")?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|_| "无法创建凭据文件")?;
        file.write_all(&encrypted)
            .and_then(|_| file.sync_all())
            .map_err(|_| "凭据保存失败")?;
        drop(file);
        std::fs::rename(&temporary, &path).map_err(|_| "凭据替换失败".to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dpapi_preserves_large_sessions_and_rejects_corruption() {
        let bytes = vec![42; 32_768];
        let mut encrypted = protect(&bytes, true).unwrap();
        assert_ne!(encrypted.as_slice(), bytes.as_slice());
        assert_eq!(
            protect(&encrypted, false).unwrap().as_slice(),
            bytes.as_slice()
        );
        let last = encrypted.len() - 1;
        encrypted[last] ^= 1;
        assert!(protect(&encrypted, false).is_err());
    }
}
