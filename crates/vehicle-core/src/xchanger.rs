//! Geely ECARX xchanger client for China Polestar 4 (`HUANFU`).
//!
//! The official China app uses this REST backend for the aggregate vehicle
//! status (including GPS) and for remote commands; the c3 gRPC
//! `InvocationService` rejects HUANFU commands. The signing scheme and the
//! application credentials were recovered from the official Android app
//! (`com.polestar.china.android` 4.25.0) and validated against a captured iOS
//! request before this module was written.
//!
//! Tokens are per-user JWTs issued by the xchanger account service. This
//! module only consumes a token; obtaining one is a separate concern so a
//! short-lived token can be supplied without rebuilding.

use crate::{now_ms, Result};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use hmac::{Hmac, Mac};
use reqwest::Client;
use serde_json::Value;
use sha1::Sha1;
use std::time::Duration;

const HOST: &str = "https://device-api.xchanger.cn";
const API_HOST: &str = "https://api.xchanger.cn";
const USER_HOST: &str = "https://user-api.xchanger.cn";
const APP_ID: &str = "polestar-app";
const OPERATOR: &str = "POLESTAR";
/// Supplied at build time like the Polestar login signing key. The official
/// app embeds this client secret; keeping it out of the repository avoids
/// publishing it a second time.
fn app_secret() -> Result<&'static str> {
    option_env!("NORR_XCHANGER_APP_SECRET")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "此构建缺少 xchanger 签名配置".to_string())
}
const ACCEPT: &str = "application/json;responseformat=3";
const USER_AGENT: &str = "china-unified-app-ios/4.25.0 (iPhone; iOS 27.3; Scale/3.00)";

pub struct XchangerClient {
    http: Client,
    token: String,
    user_id: String,
    client_id: String,
}

impl XchangerClient {
    /// Parse `uid` and `clientId` from the JWT payload. The token signature is
    /// verified by the server; this only extracts routing fields.
    pub fn from_token(token: &str) -> Result<Self> {
        let token = token.trim();
        if token.len() < 16 || token.len() > 16_384 || token.chars().any(char::is_whitespace) {
            return Err("xchanger 令牌格式无效".into());
        }
        let payload = token.split('.').nth(1).ok_or("xchanger 令牌缺少负载")?;
        let bytes = URL_SAFE_NO_PAD
            .decode(payload)
            .map_err(|_| "xchanger 令牌负载无效")?;
        let claims: Value = serde_json::from_slice(&bytes).map_err(|_| "xchanger 令牌负载无效")?;
        let user_id = claims["uid"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| claims["uid"].as_u64().map(|value| value.to_string()))
            .filter(|value| !value.is_empty())
            .ok_or("xchanger 令牌缺少用户身份")?;
        let client_id = claims["clientId"].as_str().unwrap_or_default().to_owned();
        Ok(Self {
            http: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|_| "无法建立 xchanger 连接")?,
            token: token.to_owned(),
            user_id,
            client_id,
        })
    }

    pub fn user_id(&self) -> &str {
        &self.user_id
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    /// Exchange the Polestar gateway access token for an ECARX session.
    /// This is the `/auth-center/account/session` step the official app runs
    /// once after the SMS login; the body field is `identityType: polestar`.
    pub async fn exchange(polestar_access: &str, existing: Option<&str>) -> Result<Self> {
        let http = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| "无法建立 xchanger 连接")?;
        let client_id = existing
            .and_then(client_id_from_token)
            .unwrap_or_else(|| "APPLE0000APP00IPHONE23C789136946".to_owned());
        let body = serde_json::to_vec(&serde_json::json!({
            "accessToken": polestar_access,
            "identityType": "polestar",
        }))
        .map_err(|_| "xchanger 交换请求编码失败")?;
        let path = "/auth-center/account/session";
        let nonce = uuid::Uuid::new_v4().to_string().to_uppercase();
        let timestamp = now_ms().to_string();
        let signature = sign(&nonce, &timestamp, "", &body, "POST", path)?;
        let mut request = http
            .post(format!("{USER_HOST}{path}"))
            .header("X-APP-ID", APP_ID)
            .header("X-OPERATOR-CODE", OPERATOR)
            .header("X-ENV-TYPE", "production")
            .header("X-DEVICE-TYPE", "mobile")
            .header("PLATFORM", "NON-CMA")
            .header("X-AGENT-TYPE", "iOS")
            .header("User-Agent", USER_AGENT)
            .header("Accept", ACCEPT)
            .header("Content-Type", "application/json; charset=utf-8")
            .header("X-TIMEZONE", "Asia/Shanghai")
            .header(
                "X-DEVICE-IDENTIFIER",
                "A15A4BE5-0352-421A-8797-66E6DDC27A01",
            )
            .header("X-DEVICE-MANUFACTURE", "Apple")
            .header("X-DEVICE-BRAND", "Apple")
            .header("X-DEVICE-MODEL", "iPhone")
            .header("X-AGENT-VERSION", "27.3")
            .header("x-api-signature-version", "1.0")
            .header("x-api-signature-nonce", &nonce)
            .header("X-TIMESTAMP", &timestamp)
            .header("X-SIGNATURE", signature);
        if !client_id.is_empty() {
            request = request.header("X-CLIENT-ID", &client_id);
        }
        if let Some(token) = existing {
            request = request.header("Authorization", token);
        }
        let response = request
            .body(body)
            .send()
            .await
            .map_err(|_| "xchanger 交换连接失败，请检查网络")?;
        let status = response.status();
        let text = response.text().await.map_err(|_| "xchanger 交换响应中断")?;
        let value: Value = serde_json::from_str(&text).map_err(|_| "xchanger 交换响应格式无效")?;
        if value["code"].as_str() != Some("1000") && value["code"].as_u64() != Some(1000) {
            let message = value["message"]
                .as_str()
                .or_else(|| value["error"]["message"].as_str())
                .unwrap_or("xchanger 交换未完成");
            return Err(format!(
                "{message}（xchanger 交换 {} / {}）",
                status.as_str(),
                value["code"]
            ));
        }
        let data = &value["data"];
        let token = data["accessToken"]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or("xchanger 交换未返回令牌")?
            .to_owned();
        let user_id = data["userId"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| data["userId"].as_u64().map(|value| value.to_string()))
            .or_else(|| {
                claims(&token)
                    .ok()
                    .and_then(|value| value["uid"].as_str().map(str::to_owned))
            })
            .ok_or("xchanger 交换未返回用户身份")?;
        Ok(Self {
            http,
            token,
            user_id,
            client_id,
        })
    }

    /// Aggregate status: position, battery, climate, locks, tyres, service.
    pub async fn status(&self, vin: &str) -> Result<Value> {
        let query = [
            ("latest", "False"),
            ("target", "basic,more"),
            ("userId", self.user_id.as_str()),
        ];
        let value = self
            .request(
                "GET",
                &format!("/remote-control/vehicle/status/{vin}"),
                &query,
                None,
            )
            .await?;
        Ok(value["vehicleStatus"].clone())
    }

    /// Charge target from the dedicated SOC settings endpoint. The value is
    /// reported in tenths of a percent (`"1000"` = 100%).
    pub async fn target_soc(&self, vin: &str) -> Result<f64> {
        let value = self
            .request_at(
                API_HOST,
                "GET",
                &format!("/remote-control/vehicle/status/soc/{vin}"),
                &[("setting", "charging")],
                None,
            )
            .await?;
        let raw = value["soc"]
            .as_str()
            .and_then(|text| text.parse::<f64>().ok())
            .or_else(|| value["soc"].as_f64())
            .ok_or("xchanger 未返回目标电量")?;
        let percent = if raw > 100.0 { raw / 10.0 } else { raw };
        if !percent.is_finite() || !(0.0..=100.0).contains(&percent) {
            return Err("xchanger 目标电量范围无效".into());
        }
        Ok(percent)
    }

    /// Set the charge target through the `RCS` service. `soc` is sent in
    /// tenths of a percent (`100` -> `"1000"`), matching the official app.
    pub async fn set_target_soc(&self, vin: &str, percent: f64) -> Result<Value> {
        if !percent.is_finite() || !(0.0..=100.0).contains(&percent) {
            return Err("目标电量范围无效".into());
        }
        let soc = ((percent.round().clamp(0.0, 100.0)) as u64) * 10;
        let body = serde_json::json!({
            "latest": false,
            "serviceParameters": [
                {"key": "operation", "value": "4"},
                {"key": "rcs.setting", "value": "1"},
                {"key": "soc", "value": soc.to_string()},
            ],
            "userId": self.user_id,
            "operationScheduling": {
                "scheduledTime": null,
                "interval": 0,
                "occurs": 0,
                "recurrentOperation": true,
                "duration": 60,
            },
            "serviceId": "RCS",
            "timestamp": now_ms().to_string(),
            "creator": "tc",
            "command": "start",
        });
        let bytes = serde_json::to_vec(&body).map_err(|_| "目标电量指令编码失败")?;
        self.request(
            "PUT",
            &format!("/remote-control/vehicle/telematics/{vin}"),
            &[],
            Some(&bytes),
        )
        .await
    }

    /// Remote command. `service_id` is e.g. `RCE_2` for parking climate;
    /// `params` is the `serviceParameters` key/value list.
    pub async fn control(
        &self,
        vin: &str,
        service_id: &str,
        command: &str,
        params: &[(&str, &str)],
        duration: u64,
    ) -> Result<Value> {
        let body = serde_json::json!({
            "command": command,
            "creator": "tc",
            "serviceId": service_id,
            "serviceParameters": params
                .iter()
                .map(|(key, value)| serde_json::json!({"key": key, "value": value}))
                .collect::<Vec<_>>(),
            "timestamp": now_ms().to_string(),
            "userId": self.user_id,
            "operationScheduling": {
                "duration": duration,
                "interval": 0,
                "occurs": 1,
                "recurrentOperation": false,
            },
        });
        let bytes = serde_json::to_vec(&body).map_err(|_| "指令编码失败")?;
        self.request(
            "PUT",
            &format!("/remote-control/vehicle/telematics/{vin}"),
            &[],
            Some(&bytes),
        )
        .await
    }

    async fn request(
        &self,
        method: &str,
        path: &str,
        query: &[(&str, &str)],
        body: Option<&[u8]>,
    ) -> Result<Value> {
        self.request_at(HOST, method, path, query, body).await
    }

    async fn request_at(
        &self,
        host: &str,
        method: &str,
        path: &str,
        query: &[(&str, &str)],
        body: Option<&[u8]>,
    ) -> Result<Value> {
        let nonce = uuid::Uuid::new_v4().to_string().to_uppercase();
        let timestamp = now_ms().to_string();
        let query_string = encode_query(query);
        let empty = [];
        let payload = body.unwrap_or(&empty);
        let signature = sign(&nonce, &timestamp, &query_string, payload, method, path)?;
        let url = if query_string.is_empty() {
            format!("{host}{path}")
        } else {
            format!("{host}{path}?{query_string}")
        };
        let mut request = self
            .http
            .request(method.parse().map_err(|_| "请求方法无效")?, url)
            .header("X-APP-ID", APP_ID)
            .header("X-OPERATOR-CODE", OPERATOR)
            .header("X-ENV-TYPE", "production")
            .header("X-CLIENT-ID", &self.client_id)
            .header("X-DEVICE-TYPE", "mobile")
            .header("PLATFORM", "NON-CMA")
            .header("X-AGENT-TYPE", "iOS")
            .header("User-Agent", USER_AGENT)
            .header("Accept", ACCEPT)
            .header("Content-Type", "application/json; charset=utf-8")
            .header("x-api-signature-version", "1.0")
            .header("x-api-signature-nonce", &nonce)
            .header("X-TIMESTAMP", &timestamp)
            .header("X-SIGNATURE", signature)
            .header("Authorization", &self.token);
        if let Some(bytes) = body {
            request = request.body(bytes.to_vec());
        }
        let response = request
            .send()
            .await
            .map_err(|_| "xchanger 连接失败，请检查网络")?;
        let status = response.status();
        let text = response.text().await.map_err(|_| "xchanger 响应中断")?;
        if text.len() > 2_000_000 {
            return Err("xchanger 响应过大".into());
        }
        let value: Value = serde_json::from_str(&text).map_err(|_| "xchanger 响应格式无效")?;
        let code = &value["code"];
        if code.as_str() != Some("1000") && code.as_u64() != Some(1000) {
            let message = value["message"]
                .as_str()
                .or_else(|| value["error"]["message"].as_str())
                .unwrap_or("xchanger 请求未完成");
            return Err(format!(
                "{message}（xchanger {} / {}）",
                status.as_str(),
                code
            ));
        }
        Ok(value["data"].clone())
    }
}

fn claims(token: &str) -> Result<Value> {
    let payload = token.split('.').nth(1).ok_or("xchanger 令牌缺少负载")?;
    let bytes = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| "xchanger 令牌负载无效")?;
    serde_json::from_slice(&bytes).map_err(|_| "xchanger 令牌负载无效".into())
}

fn client_id_from_token(token: &str) -> Option<String> {
    claims(token)
        .ok()
        .and_then(|value| value["clientId"].as_str().map(str::to_owned))
        .filter(|value| !value.is_empty())
}

fn encode_query(query: &[(&str, &str)]) -> String {
    let mut entries = query.to_vec();
    entries.sort_by(|a, b| a.0.cmp(b.0));
    entries
        .iter()
        .map(|(key, value)| {
            let value = value
                .replace(' ', "%20")
                .replace('*', "%2A")
                .replace('%', "%25")
                .replace(',', "%2C");
            format!("{key}={value}")
        })
        .collect::<Vec<_>>()
        .join("&")
}

fn canonical(
    query: &str,
    body: &[u8],
    method: &str,
    timestamp: &str,
    path: &str,
    nonce: &str,
) -> String {
    let md5 = STANDARD.encode(md5::compute(body).0);
    format!(
        "{ACCEPT}\nx-api-signature-nonce:{nonce}\nx-api-signature-version:1.0\n\n{query}\n{md5}\n{timestamp}\n{method}\n{path}"
    )
}

fn sign(
    nonce: &str,
    timestamp: &str,
    query: &str,
    body: &[u8],
    method: &str,
    path: &str,
) -> Result<String> {
    let text = canonical(query, body, method, timestamp, path, nonce);
    let mut mac = Hmac::<Sha1>::new_from_slice(app_secret()?.as_bytes())
        .map_err(|_| "xchanger 签名初始化失败")?;
    mac.update(text.as_bytes());
    Ok(STANDARD.encode(mac.finalize().into_bytes()))
}

/// xchanger sometimes returns degrees and sometimes arc-milliseconds
/// (degrees × 3,600,000); disambiguate by magnitude.
pub fn coordinate(raw: &Value) -> Option<f64> {
    let value = raw
        .as_f64()
        .or_else(|| raw.as_str().and_then(|text| text.parse().ok()))?;
    if !value.is_finite() {
        return None;
    }
    let degrees = if value.abs() <= 180.0 {
        value
    } else {
        value / 3_600_000.0
    };
    (-180.0..=180.0).contains(&degrees).then_some(degrees)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_matches_the_captured_ios_request() {
        // Shape verified against a real iOS request; the VIN is replaced with a
        // placeholder so the test carries no vehicle identity.
        let text = canonical(
            "latest=False&target=basic%2Cmore&userId=1",
            b"",
            "GET",
            "1795237503850",
            "/remote-control/vehicle/status/PLACEHOLDER000000",
            "D06E68FE-6137-4DF1-8DBF-29329337EBA5",
        );
        assert_eq!(
            text,
            "application/json;responseformat=3\n\
             x-api-signature-nonce:D06E68FE-6137-4DF1-8DBF-29329337EBA5\n\
             x-api-signature-version:1.0\n\
             \n\
             latest=False&target=basic%2Cmore&userId=1\n\
             1B2M2Y8AsgTpgAmY7PhCfg==\n\
             1795237503850\n\
             GET\n\
             /remote-control/vehicle/status/PLACEHOLDER000000"
        );
    }

    #[test]
    fn query_encoding_keeps_the_official_comma_escape() {
        assert_eq!(
            encode_query(&[
                ("latest", "False"),
                ("target", "basic,more"),
                ("userId", "1")
            ]),
            "latest=False&target=basic%2Cmore&userId=1"
        );
    }

    #[test]
    fn coordinates_accept_degrees_and_arc_milliseconds() {
        assert_eq!(coordinate(&serde_json::json!(39.85)), Some(39.85));
        assert!((coordinate(&serde_json::json!("140400000")).unwrap() - 39.0).abs() < 1e-9);
        assert_eq!(coordinate(&serde_json::json!("not-a-number")), None);
    }

    #[test]
    fn token_claims_are_read_without_verifying_the_signature() {
        let payload = URL_SAFE_NO_PAD.encode(
            serde_json::json!({"uid": "1", "clientId": "APPLE0000", "operator": "POLESTAR"})
                .to_string(),
        );
        let token = format!("header.{payload}.signature");
        let client = XchangerClient::from_token(&token).unwrap();
        assert_eq!(client.user_id(), "1");
        assert_eq!(client.client_id, "APPLE0000");
    }
}
