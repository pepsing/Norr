use crate::{china::gateway_url, credentials, now_ms, Result};
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Verification {
    session_id: String,
    sig: String,
    token: String,
}

impl Verification {
    pub fn validate(&self) -> Result<()> {
        if [&self.session_id, &self.sig, &self.token]
            .iter()
            .any(|value| value.trim().is_empty() || value.len() > 8192)
        {
            return Err("验证结果无效，请重新完成滑块验证".into());
        }
        Ok(())
    }
}

pub fn validate_phone(phone: &str) -> Result<()> {
    if phone.len() != 11 || !phone.starts_with('1') || !phone.bytes().all(|b| b.is_ascii_digit()) {
        return Err("请输入 11 位中国大陆手机号".into());
    }
    Ok(())
}

pub fn validate_code(code: &str) -> Result<()> {
    if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return Err("请输入 6 位短信验证码".into());
    }
    Ok(())
}

pub struct PhoneLogin {
    http: Client,
    sent_phone: Option<String>,
    next_send_at: u64,
    pending_session: Option<credentials::Session>,
}

impl PhoneLogin {
    pub fn new() -> Result<Self> {
        Ok(Self {
            http: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|_| "无法建立登录连接")?,
            sent_phone: None,
            next_send_at: 0,
            pending_session: None,
        })
    }

    pub fn ready_to_send(&self, phone: &str) -> Result<()> {
        validate_phone(phone)?;
        if now_ms() < self.next_send_at {
            return Err("请等待发送倒计时结束后重试".into());
        }
        Ok(())
    }

    pub async fn send_code(&mut self, phone: &str, verification: Verification) -> Result<u64> {
        self.ready_to_send(phone)?;
        verification.validate()?;
        let key = credentials::signing_key()?;
        let device = credentials::device_id()?;
        self.next_send_at = now_ms() + 60_000;
        let data = self
            .post(
                "/user/api/v1/credcode/send",
                json!({"principal": phone, "aliScene": "ic_login_h5",
                "aliSessionId": verification.session_id, "aliSign": verification.sig,
                "aliToken": verification.token, "clientId": "polestar-app-android",
                "type": "SIGNIN_BY_PHONE"}),
                &key,
                &device,
            )
            .await?;
        if data != true {
            return Err("短信发送未确认，请稍后重新获取验证码".into());
        }
        self.sent_phone = Some(phone.to_owned());
        self.pending_session = None;
        Ok(self.next_send_at)
    }

    pub async fn sign_in(&mut self, phone: &str, code: &str) -> Result<credentials::Session> {
        validate_phone(phone)?;
        validate_code(code)?;
        if self.sent_phone.as_deref() != Some(phone) {
            return Err("请先为此手机号获取短信验证码".into());
        }
        if let Some(session) = &self.pending_session {
            return Ok(session.clone());
        }
        let data = self
            .post(
                "/user/api/v2/oauth/login/phone",
                json!({"clientId": "polestar-app-android", "phone": phone,
                "credential": code, "autocrt": true}),
                &credentials::signing_key()?,
                &credentials::device_id()?,
            )
            .await?;
        let login = serde_json::from_value(data).map_err(|_| "登录响应格式无效")?;
        let session = credentials::Session::from_login(login)?;
        self.pending_session = Some(session.clone());
        Ok(session)
    }

    pub fn finish(&mut self) {
        self.sent_phone = None;
        self.pending_session = None;
    }

    pub fn retry_at(&self) -> u64 {
        self.next_send_at
    }

    async fn post(&self, path: &str, body: Value, key: &str, device: &str) -> Result<Value> {
        let url = gateway_url(
            path,
            key,
            device,
            now_ms(),
            &uuid::Uuid::new_v4().to_string().to_uppercase(),
        )?;
        let mut response = self
            .http
            .post(url)
            .header("Content-Type", "application/json; charset=utf-8")
            .json(&body)
            .send()
            .await
            .map_err(|_| "登录服务连接失败，请检查网络后重试")?;
        let status = response.status().as_u16();
        if status == 429 {
            return Err("操作频繁，请稍后重新获取验证码".into());
        }
        if !response.status().is_success() {
            return Err(format!("登录服务暂不可用（HTTP {status}），请稍后重试"));
        }
        let mut bytes = zeroize::Zeroizing::new(Vec::new());
        while let Some(chunk) = response.chunk().await.map_err(|_| "登录服务响应中断")? {
            if bytes.len() + chunk.len() > 128_000 {
                return Err("登录响应超过大小限制".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let envelope: Value = serde_json::from_slice(&bytes).map_err(|_| "登录响应格式无效")?;
        decode_response(envelope, path.ends_with("/send"))
    }
}

fn decode_response(envelope: Value, sending: bool) -> Result<Value> {
    if envelope["status"].as_i64() != Some(200) || envelope["code"].as_i64() != Some(200) {
        return Err(if sending {
            "短信未发送成功，请稍后重新完成滑块验证"
        } else {
            "登录未成功，请检查验证码或重新获取"
        }
        .into());
    }
    envelope
        .get("data")
        .filter(|value| !value.is_null())
        .cloned()
        .ok_or_else(|| "登录响应缺少数据".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_rejects_invalid_inputs_and_malformed_grants() {
        for phone in [
            "",
            "123",
            "+8613800000000",
            "1380000000a",
            "１３８００００００００",
        ] {
            assert!(validate_phone(phone).is_err());
        }
        for code in ["", "12345", "1234567", "１２３４５６", "12345a"] {
            assert!(validate_code(code).is_err());
        }
        let invalid: Verification =
            serde_json::from_value(json!({"sessionId":" ","sig":"fixture","token":"fixture"}))
                .unwrap();
        assert!(invalid.validate().is_err());
        assert!(decode_response(json!({"status":200,"code":401,"data":true}), false).is_err());
        let login = serde_json::from_value(json!({"userUid":"fixture", "globleToken":{
            "accessToken":"", "refreshToken":"fixture", "tokenType":"bearer", "expiresIn":3600
        }}))
        .unwrap();
        assert!(credentials::Session::from_login(login).is_err());
    }

    #[tokio::test]
    async fn phone_mismatch_and_cooldown_fail_before_network_or_keychain() {
        let mut flow = PhoneLogin::new().unwrap();
        flow.sent_phone = Some("13800000000".into());
        assert_eq!(
            flow.sign_in("13900000000", "123456").await.err().unwrap(),
            "请先为此手机号获取短信验证码"
        );
        flow.next_send_at = now_ms() + 60_000;
        assert!(flow.ready_to_send("13800000000").is_err());
        flow.finish();
        assert!(flow.sent_phone.is_none());
    }

    #[tokio::test]
    async fn saving_retry_reuses_issued_session_until_commit() {
        let mut flow = PhoneLogin::new().unwrap();
        flow.sent_phone = Some("13800000000".into());
        flow.pending_session = Some(
            credentials::Session::from_login(
                serde_json::from_value(json!({
                    "userUid":"fixture", "globleToken": {"accessToken":"fixture-access",
                        "refreshToken":"fixture-refresh", "tokenType":"bearer", "expiresIn":3600}
                }))
                .unwrap(),
            )
            .unwrap(),
        );
        let session = flow.sign_in("13800000000", "123456").await.unwrap();
        assert_eq!(session.login.user_uid, "fixture");
        assert!(flow.sign_in("13900000000", "123456").await.is_err());
        flow.finish();
        assert!(flow.pending_session.is_none());
    }
}
