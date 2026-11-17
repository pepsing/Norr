use norr_vehicle_core::{credentials::harmonyos::SecureStorage, Result};
use ring::{
    aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM},
    rand::{SecureRandom, SystemRandom},
};
use std::{fs::OpenOptions, io::Write, os::unix::fs::OpenOptionsExt, path::PathBuf};
use zeroize::Zeroizing;

extern "C" {
    fn norr_storage_key(candidate: *const u8, output: *mut u8) -> i32;
}

pub struct Storage {
    directory: PathBuf,
    key: LessSafeKey,
}

impl Storage {
    pub fn new(directory: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&directory).map_err(|_| "无法创建凭据目录")?;
        crate::platform::private_path(&directory, 0o700)?;
        let mut candidate = Zeroizing::new([0u8; 32]);
        let mut key = Zeroizing::new([0u8; 32]);
        SystemRandom::new()
            .fill(candidate.as_mut())
            .map_err(|_| "安全随机数不可用")?;
        let status = unsafe { norr_storage_key(candidate.as_ptr(), key.as_mut_ptr()) };
        if status != 0 {
            return Err(format!("鸿蒙安全存储不可用（{status}）"));
        }
        let key = UnboundKey::new(&AES_256_GCM, key.as_ref()).map_err(|_| "凭据加密初始化失败")?;
        Ok(Self {
            directory,
            key: LessSafeKey::new(key),
        })
    }

    fn path(&self, account: &str) -> Result<PathBuf> {
        if ![
            "polestar-china-session",
            "polestar-china-signing-key",
            "device-id",
        ]
        .contains(&account)
        {
            return Err("凭据名称无效".into());
        }
        Ok(self.directory.join(format!("{account}.enc")))
    }
}

impl SecureStorage for Storage {
    fn read(&self, account: &str) -> Result<Option<String>> {
        let path = self.path(account)?;
        let mut bytes = match std::fs::read(path) {
            Ok(bytes) => Zeroizing::new(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("无法读取本机凭据".into()),
        };
        if bytes.len() < 32 || &bytes[..4] != b"NRH1" {
            return Err("本机凭据格式无效".into());
        }
        let nonce: [u8; 12] = bytes[4..16].try_into().map_err(|_| "凭据随机数无效")?;
        let plain = self
            .key
            .open_in_place(
                Nonce::assume_unique_for_key(nonce),
                Aad::from(account.as_bytes()),
                &mut bytes[16..],
            )
            .map_err(|_| "凭据解密失败，请重新登录")?;
        String::from_utf8(plain.to_vec())
            .map(Some)
            .map_err(|_| "凭据内容无效".into())
    }

    fn write(&self, account: &str, value: &str) -> Result<()> {
        let path = self.path(account)?;
        let mut nonce = [0u8; 12];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| "安全随机数不可用")?;
        let mut encrypted = Zeroizing::new(value.as_bytes().to_vec());
        self.key
            .seal_in_place_append_tag(
                Nonce::assume_unique_for_key(nonce),
                Aad::from(account.as_bytes()),
                &mut *encrypted,
            )
            .map_err(|_| "凭据加密失败")?;
        let temporary = path.with_extension("tmp");
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(|_| "无法保存加密凭据")?;
        file.write_all(b"NRH1")
            .and_then(|_| file.write_all(&nonce))
            .and_then(|_| file.write_all(&encrypted))
            .and_then(|_| file.sync_all())
            .map_err(|_| "加密凭据写入失败")?;
        drop(file);
        std::fs::rename(temporary, path).map_err(|_| "加密凭据保存失败".into())
    }
}
