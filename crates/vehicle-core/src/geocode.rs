//! Keyless Chinese reverse geocoding for the P4 xchanger position.
//!
//! The official app uses AMap's on-device SDK with a platform-locked key, so
//! that key cannot be reused here. OpenStreetMap Nominatim covers the same
//! address in Chinese and needs no key; calls are made only when the displayed
//! position changes, which stays well inside its one-request-per-second policy.

use crate::Result;
use reqwest::Client;
use serde_json::Value;
use std::time::Duration;

const USER_AGENT: &str = "Norr/0.1 (+https://github.com/pepsing/Norr)";

fn valid(latitude: f64, longitude: f64) -> bool {
    latitude.is_finite()
        && longitude.is_finite()
        && (-90.0..=90.0).contains(&latitude)
        && (-180.0..=180.0).contains(&longitude)
}

pub async fn reverse(latitude: f64, longitude: f64) -> Result<String> {
    if !valid(latitude, longitude) {
        return Err("坐标无效".into());
    }
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "无法建立地址查询连接")?;
    let url = format!(
        "https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat={latitude:.7}&lon={longitude:.7}&zoom=18&addressdetails=1&accept-language=zh-CN"
    );
    let response = client
        .get(url)
        .header("User-Agent", USER_AGENT)
        .header("Accept-Language", "zh-CN")
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|_| "地址查询连接失败，请检查网络")?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("地址查询未完成（HTTP {}）", status.as_u16()));
    }
    let value: Value = response.json().await.map_err(|_| "地址查询响应格式无效")?;
    value["display_name"]
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "车辆位置附近没有可用地址".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_impossible_coordinates() {
        assert!(!valid(91.0, 0.0));
        assert!(!valid(0.0, 181.0));
        assert!(!valid(f64::NAN, 0.0));
        assert!(valid(39.854_7, 116.297_3));
    }
}
