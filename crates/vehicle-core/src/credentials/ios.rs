use crate::Result;
use security_framework::passwords::{get_generic_password, set_generic_password};
use zeroize::Zeroizing;

pub(super) fn read(service: &str, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>> {
    match get_generic_password(service, account) {
        Ok(bytes) => Ok(Some(Zeroizing::new(bytes))),
        Err(error) if error.code() == -25300 => Ok(None),
        Err(error) => Err(format!("iOS 钥匙串读取失败（{}）", error.code())),
    }
}

pub(super) fn write(service: &str, account: &str, bytes: &[u8]) -> Result<()> {
    set_generic_password(service, account, bytes)
        .map_err(|error| format!("iOS 凭据保存失败（{}）", error.code()))
}
