use crate::{now_ms, Result};
use serde::{Deserialize, Serialize};
#[cfg(all(target_os = "macos", debug_assertions))]
use std::path::Path;
use zeroize::Zeroizing;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "macos")]
use macos::{read, write};
#[cfg(target_os = "windows")]
use windows::{read, write};
#[cfg(target_os = "ios")]
mod ios;
#[cfg(target_os = "ios")]
use ios::{read, write};
#[cfg(target_os = "android")]
pub mod android;
#[cfg(target_os = "android")]
use android::{read, write};

#[cfg(target_os = "macos")]
const SERVICE: &str = "app.norr.mac";
#[cfg(target_os = "windows")]
const SERVICE: &str = "app.norr.windows";
#[cfg(target_os = "android")]
const SERVICE: &str = "app.norr.mobile";
#[cfg(target_os = "ios")]
const SERVICE: &str = "app.norr.ios";
#[cfg(all(target_os = "macos", debug_assertions))]
const LEGACY_SERVICE: &str = "io.kheirallah.hisingen";
const ACCOUNT: &str = "polestar-china-session";
const APPLE_EPOCH: f64 = 978_307_200.0;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub access_token: String,
    pub refresh_token: String,
    pub token_type: String,
    pub expires_in: u64,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Login {
    pub user_uid: String,
    pub globle_token: Grant,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub login: Login,
    pub global_issued_at: f64,
    pub issued_at: f64,
}

impl Session {
    pub fn from_login(login: Login) -> Result<Self> {
        let issued_at = now_ms() as f64 / 1000.0 - APPLE_EPOCH;
        let session = Self {
            login,
            global_issued_at: issued_at,
            issued_at,
        };
        session.validate().map_err(|_| "登录响应缺少有效授权")?;
        Ok(session)
    }

    pub fn needs_refresh(&self) -> bool {
        self.expires_at() <= now_ms() + 60_000
    }

    pub fn expires_at(&self) -> u64 {
        ((self.global_issued_at + APPLE_EPOCH + self.login.globle_token.expires_in as f64) * 1000.0)
            as u64
    }

    pub fn replace_grant(&mut self, grant: Grant) {
        self.login.globle_token = grant;
        self.global_issued_at = now_ms() as f64 / 1000.0 - APPLE_EPOCH;
    }

    fn validate(&self) -> Result<()> {
        let grant = &self.login.globle_token;
        if self.login.user_uid.is_empty()
            || grant.access_token.is_empty()
            || grant.refresh_token.is_empty()
            || !grant.token_type.eq_ignore_ascii_case("bearer")
            || !(1..=31_536_000).contains(&grant.expires_in)
            || !self.global_issued_at.is_finite()
        {
            return Err("已保存的会话格式不完整".into());
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    pub has_session: bool,
    pub has_signing_key: bool,
    pub expires_at: Option<u64>,
}

pub fn load_session() -> Result<Option<Session>> {
    load_from(SERVICE)
}

fn load_from(service: &str) -> Result<Option<Session>> {
    let Some(bytes) = read(service, ACCOUNT)? else {
        return Ok(None);
    };
    let session: Session =
        serde_json::from_slice(&bytes).map_err(|_| "无法解析已存会话".to_string())?;
    session.validate()?;
    Ok(Some(session))
}

pub fn save_session(session: &Session) -> Result<()> {
    session.validate()?;
    let bytes =
        Zeroizing::new(serde_json::to_vec(session).map_err(|_| "会话编码失败".to_string())?);
    write(SERVICE, ACCOUNT, &bytes)
}

pub fn signing_key() -> Result<Zeroizing<String>> {
    if let Some(bytes) = read(SERVICE, "polestar-china-signing-key")? {
        return String::from_utf8(bytes.to_vec())
            .map(Zeroizing::new)
            .map_err(|_| "签名配置格式错误".into());
    }
    bundled_signing_key()
        .map(|key| Zeroizing::new(key.to_owned()))
        .ok_or_else(|| "此安装包缺少中国区登录配置，请安装包含登录配置的版本".into())
}

fn bundled_signing_key() -> Option<&'static str> {
    option_env!("NORR_POLESTAR_CN_SIGNING_KEY").filter(|key| !key.trim().is_empty())
}

pub fn device_id() -> Result<String> {
    if let Some(bytes) = read(SERVICE, "device-id")? {
        return String::from_utf8(bytes.to_vec()).map_err(|_| "设备标识无效".into());
    }
    let id = uuid::Uuid::new_v4().to_string().to_uppercase();
    write(SERVICE, "device-id", id.as_bytes())?;
    Ok(id)
}

pub fn status() -> Result<SessionStatus> {
    let session = load_session()?;
    Ok(SessionStatus {
        has_session: session.is_some(),
        has_signing_key: bundled_signing_key().is_some()
            || read(SERVICE, "polestar-china-signing-key")?.is_some(),
        expires_at: session.map(|value| value.expires_at()),
    })
}

#[cfg(all(target_os = "macos", debug_assertions))]
pub fn import_hisingen(config: Option<&Path>) -> Result<SessionStatus> {
    let legacy = load_from(LEGACY_SERVICE)?.ok_or("本机没有可恢复的 Hisingen 中国区会话")?;
    if let Some(path) = config {
        let text = Zeroizing::new(
            std::fs::read_to_string(path).map_err(|_| "无法读取所选配置文件".to_string())?,
        );
        let key = text
            .lines()
            .filter_map(|line| line.trim().split_once('='))
            .find(|(name, _)| name.trim() == "POLESTAR_CN_SIGNING_KEY")
            .map(|(_, value)| value.trim().trim_matches(['\'', '"']))
            .filter(|value| !value.is_empty())
            .ok_or("配置中缺少 POLESTAR_CN_SIGNING_KEY")?;
        write(SERVICE, "polestar-china-signing-key", key.as_bytes())?;
    }
    if load_session()?
        .map(|current| current.global_issued_at < legacy.global_issued_at)
        .unwrap_or(true)
    {
        save_session(&legacy)?;
    }
    status()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swift_epoch_and_outer_expiry_do_not_block_global_session() {
        let mut session: Session = serde_json::from_value(serde_json::json!({
            "login": {"userUid":"test", "expiresIn":0, "globleToken":{
                "accessToken":"fixture", "refreshToken":"fixture", "tokenType":"bearer", "expiresIn":3600
            }}, "globalIssuedAt":now_ms() as f64/1000.0-APPLE_EPOCH, "issuedAt":0
        })).unwrap();
        session.validate().unwrap();
        assert!(!session.needs_refresh());
        session.global_issued_at -= 3600.0;
        assert!(session.needs_refresh());
    }
}
