use crate::Result;
use security_framework::passwords::{generic_password, set_generic_password, PasswordOptions};
use zeroize::Zeroizing;

pub(super) fn read(service: &str, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>> {
    for protected in [true, false] {
        let mut options = PasswordOptions::new_generic_password(service, account);
        if protected {
            options.use_protected_keychain();
        }
        match generic_password(options) {
            Ok(bytes) => return Ok(Some(Zeroizing::new(bytes))),
            Err(error) if error.code() == -25300 => continue,
            Err(error) if protected && error.code() == -34018 => continue,
            Err(error) => {
                return Err(format!(
                    "钥匙串访问失败（{}），请允许 Norr 访问本机凭据",
                    error.code()
                ))
            }
        }
    }
    Ok(None)
}

pub(super) fn write(service: &str, account: &str, bytes: &[u8]) -> Result<()> {
    set_generic_password(service, account, bytes)
        .map_err(|error| format!("凭据保存失败（{}）", error.code()))
}
