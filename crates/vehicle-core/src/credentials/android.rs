use crate::Result;
use std::sync::OnceLock;
use zeroize::Zeroizing;

pub trait SecureStorage: Send + Sync {
    fn read(&self, account: &str) -> Result<Option<String>>;
    fn write(&self, account: &str, value: &str) -> Result<()>;
}

static STORAGE: OnceLock<Box<dyn SecureStorage>> = OnceLock::new();

pub fn initialize(storage: Box<dyn SecureStorage>) -> Result<()> {
    STORAGE
        .set(storage)
        .map_err(|_| "Android 凭据存储已初始化".into())
}

pub(super) fn read(_service: &str, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>> {
    STORAGE
        .get()
        .ok_or("Android 凭据存储尚未就绪")?
        .read(account)
        .map(|value| value.map(|value| Zeroizing::new(value.into_bytes())))
}

pub(super) fn write(_service: &str, account: &str, bytes: &[u8]) -> Result<()> {
    let value = std::str::from_utf8(bytes).map_err(|_| "凭据格式无效")?;
    STORAGE
        .get()
        .ok_or("Android 凭据存储尚未就绪")?
        .write(account, value)
}
