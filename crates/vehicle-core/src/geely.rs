use crate::{
    credentials::{self, Session},
    models::*,
    now_ms, Result,
};
use reqwest::{Client, Method, Url};
use ring::hmac;
use serde_json::{json, Value};
mod availability;
mod control;
mod error;
mod session;
use error::RequestError;
mod readings;
mod signing;
mod storage;
pub use control::{execute_control, prepare_control, validate_control, PreparedControl};
#[cfg(target_os = "android")]
pub use storage::initialize_android_directory;

pub fn candidate(car: &Vehicle) -> bool {
    car.platform
        .as_deref()
        .is_some_and(|v| v.eq_ignore_ascii_case("HUANFU"))
}

struct Api<'a> {
    http: &'a Client,
    key: hmac::Key,
    device: String,
    #[cfg(test)]
    endpoint: Option<String>,
    #[cfg(test)]
    sessions: Option<std::sync::Arc<tokio::sync::Mutex<Value>>>,
}

impl Api<'_> {
    fn new(http: &Client) -> Result<Api<'_>> {
        Ok(Api {
            http,
            key: hmac::Key::new(
                hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY,
                &credentials::geely_signing_key()?,
            ),
            device: credentials::device_id()?
                .bytes()
                .map(|b| format!("{b:02x}"))
                .collect(),
            #[cfg(test)]
            endpoint: None,
            #[cfg(test)]
            sessions: None,
        })
    }

    async fn raw_request(
        &self,
        method: Method,
        host: &str,
        path: &str,
        params: &[(&str, &str)],
        body: Option<Value>,
        grant: &Value,
    ) -> Result<(u16, Value)> {
        let mut url =
            Url::parse(&format!("https://{host}.xchanger.cn{path}")).map_err(|_| "P4 地址无效")?;
        #[cfg(test)]
        if let Some(endpoint) = &self.endpoint {
            url = Url::parse(&format!("{endpoint}{path}")).map_err(|_| "测试地址无效")?;
        }
        signing::set_query(&mut url, params);
        let payload = body.map(|b| b.to_string()).unwrap_or_default();
        let time = now_ms();
        let nonce = uuid::Uuid::new_v4().to_string();
        let signature =
            signing::signature(&self.key, &url, payload.as_bytes(), time, &nonce, &method);
        let mut req = self
            .http
            .request(method, url)
            .header("Accept", signing::ACCEPT)
            .header("Content-Type", "application/json; charset=utf-8")
            .header("X-APP-ID", "polestar-app")
            .header("X-AGENT-TYPE", "android")
            .header("X-DEVICE-TYPE", "mobile")
            .header("X-OPERATOR-CODE", "POLESTAR")
            .header("X-ENV-TYPE", "production")
            .header("X-VERSION", "polestarNew")
            .header("PLATFORM", "NON-CMA")
            .header("X-DEVICE-IDENTIFIER", &self.device)
            .header("Accept-Language", "zh-CN")
            .header("X-api-signature-version", "1.0")
            .header("X-api-signature-nonce", nonce)
            .header("X-SIGNATURE", signature)
            .header("X-TIMESTAMP", time);
        if let Some(token) = grant["accessToken"].as_str() {
            req = req.header("Authorization", token).header(
                "X-CLIENT-ID",
                grant["clientId"].as_str().ok_or("P4 会话不完整")?,
            );
        } else {
            req = req
                .header("X-DEVICE-MANUFACTURE", "Apple")
                .header("X-DEVICE-BRAND", "Norr")
                .header("X-DEVICE-MODEL", "Norr P4")
                .header("X-AGENT-VERSION", "macOS");
        }
        if !payload.is_empty() {
            req = req.body(payload);
        }
        let response = req.send().await.map_err(|_| "P4 服务连接失败")?;
        let status = response.status().as_u16();
        // Keep HTTP rejection evidence even when the server returns a non-JSON error page.
        let data = response.json().await.unwrap_or(Value::Null);
        Ok((status, data))
    }

    async fn request(
        &self,
        method: Method,
        host: &str,
        path: &str,
        params: &[(&str, &str)],
        body: Option<Value>,
        grant: &Value,
    ) -> std::result::Result<Value, RequestError> {
        let (status, data) = self
            .raw_request(method, host, path, params, body, grant)
            .await
            .map_err(RequestError::Other)?;
        error::response(status, data)
    }
}

struct VehicleRead<'a> {
    api: &'a Api<'a>,
    session: &'a Session,
    grant: Value,
    renewed: tokio::sync::OnceCell<Result<Value>>,
}

impl VehicleRead<'_> {
    async fn control_reading(&self, car: &Vehicle, kind: &str) -> Result<Reading> {
        if kind == "target" {
            return Ok(crate::p4_readback::charge_target(
                self.get(
                    "api",
                    &format!("/remote-control/vehicle/status/soc/{}", car.vin),
                    &[("setting", "charging")],
                )
                .await,
            ));
        }
        self.status_snapshot(car)
            .await?
            .readings
            .remove(kind)
            .ok_or_else(|| "P4 该读数待验证".into())
    }

    async fn status_snapshot(&self, car: &Vehicle) -> Result<Snapshot> {
        let uid = self.grant["userId"].as_str().ok_or("P4 会话缺少车辆授权")?;
        let status = self
            .get(
                "device-api",
                &format!("/remote-control/vehicle/status/{}", car.vin),
                &[("userId", uid), ("latest", "false"), ("target", "")],
            )
            .await;
        readings::snapshot(car, status, Err("未请求独立充电读数".into()))
    }

    async fn profile(&self, vin: &str) -> Result<Value> {
        let uid = self.grant["userId"].as_str().ok_or("P4 会话缺少车辆授权")?;
        let fleet = self
            .get(
                "device-api",
                "/device-platform/user/vehicle/secure",
                &[("userId", uid), ("needSharedCar", "1")],
            )
            .await?;
        profile(&fleet, vin)
    }

    async fn capabilities(&self, vin: &str, profile: &Value) -> Result<Value> {
        let typ = profile["vehicleType"]
            .as_i64()
            .ok_or("P4 车库未返回车辆类型")?
            .to_string();
        self.get(
            "api",
            &format!("/geelyTCAccess/tcservices/capability/{vin}"),
            &[
                ("pageSize", "2000"),
                ("pageIndex", "1"),
                ("vehicleType", &typ),
                ("sortField", ""),
                ("direction", ""),
            ],
        )
        .await
    }

    async fn get(&self, host: &str, path: &str, params: &[(&str, &str)]) -> Result<Value> {
        if self.renewed.get().is_none() {
            match self
                .api
                .request(Method::GET, host, path, params, None, &self.grant)
                .await
            {
                Err(error) if error.authentication() => {}
                result => return result.map_err(|error| error.message("车辆读取")),
            }
        }
        let grant = self
            .renewed
            .get_or_init(|| self.api.grant(self.session, Some(&self.grant)))
            .await
            .as_ref()
            .map_err(Clone::clone)?;
        self.api
            .request(Method::GET, host, path, params, None, grant)
            .await
            .map_err(|error| {
                if error.authentication() {
                    format!(
                        "{}，请核对账号的车辆访问权限",
                        error.message("会话恢复后的车辆读取")
                    )
                } else {
                    error.message("车辆读取")
                }
            })
    }
}

fn validate_vin(vin: &str) -> Result<()> {
    if vin.len() != 17
        || !vin
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
    {
        return Err("P4 车辆标识无效".into());
    }
    Ok(())
}

fn profile(fleet: &Value, vin: &str) -> Result<Value> {
    if fleet
        .pointer("/serviceResult/operationResult")
        .is_some_and(|v| readings::num(v) != Some(0.))
    {
        return Err("P4 车库请求未完成".into());
    }
    fleet["list"]
        .as_array()
        .and_then(|list| list.iter().find(|v| v["vin"] == vin))
        .cloned()
        .ok_or_else(|| "P4 未列入当前 Geely 账号车库".into())
}

pub async fn refresh_reading(
    http: &Client,
    session: &Session,
    car: &Vehicle,
    kind: &str,
) -> Result<Reading> {
    if !matches!(kind, "target" | "climate" | "exterior" | "airQuality") {
        return refresh(http, session, car)
            .await?
            .readings
            .remove(kind)
            .ok_or_else(|| "P4 该读数待验证".into());
    }
    validate_vin(&car.vin)?;
    let api = Api::new(http)?;
    let grant = api.grant(session, None).await?;
    let reader = VehicleRead {
        api: &api,
        session,
        grant,
        renewed: Default::default(),
    };
    reader.profile(&car.vin).await?;
    reader.control_reading(car, kind).await
}

pub async fn refresh(http: &Client, session: &Session, car: &Vehicle) -> Result<Snapshot> {
    let vin = &car.vin;
    validate_vin(vin)?;
    let api = Api::new(http)?;
    let grant = api.grant(session, None).await?;
    let reader = VehicleRead {
        api: &api,
        session,
        grant,
        renewed: Default::default(),
    };
    let uid = reader.grant["userId"]
        .as_str()
        .ok_or("P4 会话缺少车辆授权")?;
    let profile = reader.profile(vin).await?;
    let status_path = format!("/remote-control/vehicle/status/{vin}");
    let state_path = format!("/remote-control/vehicle/status/state/{vin}");
    let charge_path = format!("/charge-server/charge_status/{vin}");
    let target_path = format!("/remote-control/vehicle/status/soc/{vin}");
    let reservation_path = format!("/charge-server/ecarx_charge_set/{vin}");
    let filter = [("userId", uid), ("latest", "false"), ("target", "")];
    let user = [("userId", uid)];
    let (status, state, cap, charge, target, reservation) = tokio::join!(
        reader.get("device-api", &status_path, &filter),
        reader.get("device-api", &state_path, &user),
        reader.capabilities(vin, &profile),
        reader.get("api", &charge_path, &[]),
        reader.get("api", &target_path, &[("setting", "charging")]),
        reader.get("api", &reservation_path, &[("bizType", "2")])
    );
    if let Some(Err(error)) = reader.renewed.get() {
        return Err(error.clone());
    }
    let mut snapshot = readings::snapshot(car, status, charge)?;
    snapshot
        .readings
        .insert("target".into(), crate::p4_readback::charge_target(target));
    control::apply_capabilities(&mut snapshot.vehicle, cap.as_ref().ok());
    availability::apply(&mut snapshot, cap.as_ref().ok());
    if let Ok(v) = state {
        if v["vin"] == vin.as_str() {
            snapshot.readings.insert("vehicleModes".into(),Reading::success(json!({"campingCode":v["campingModeActive"],"parkComfortCode":v["parkComfortState"]}),None));
        }
    }
    let plans = match reservation {
        Ok(v) if v["scheduleList"].is_array() => {
            let entries: Vec<_> = v["scheduleList"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|plan| {
                    let start = plan["startTime"].as_str().filter(|time| {
                        time.len() == 5
                            && time.as_bytes()[2] == b':'
                            && time.split_once(':').is_some_and(|(h, m)| {
                                h.parse::<u8>().is_ok_and(|n| n < 24)
                                    && m.parse::<u8>().is_ok_and(|n| n < 60)
                            })
                    });
                    json!({"start":start})
                })
                .collect();
            Reading::success(json!({"entries":entries}), None)
        }
        Err(error) => Reading::failure(error),
        _ => Reading::failure("服务未返回可识别的预约列表".into()),
    };
    snapshot.readings.insert("p4Reservations".into(), plans);
    Ok(snapshot)
}
