use super::{credentials, validate_vin, Api, Client, Session, Value, Vehicle, VehicleRead};
use crate::{now_ms, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::json;

pub(crate) async fn authorization(
    http: &Client,
    session: &Session,
    car: &Vehicle,
) -> Result<Value> {
    validate_vin(&car.vin)?;
    let api = Api::new(http)?;
    let reader = VehicleRead {
        api: &api,
        session,
        grant: api.grant(session, None).await?,
        renewed: Default::default(),
    };
    reader.profile(&car.vin).await?;
    let grant = match reader.renewed.get() {
        Some(value) => value.as_ref().map_err(Clone::clone)?,
        None => &reader.grant,
    };
    let stored = credentials::geely_session()?.ok_or("请先恢复 P4 连接再同步手表")?;
    let expires = access_expiry(&stored, grant, &session.account_scope(), now_ms())?;
    Ok(json!({
        "accessToken": grant["accessToken"], "userId": grant["userId"],
        "clientId": grant["clientId"], "expiresAt": expires,
        "deviceId": api.device, "signingKey": STANDARD.encode(credentials::geely_signing_key()?),
    }))
}

fn access_expiry(stored: &Value, grant: &Value, account: &str, now: u64) -> Result<u64> {
    if stored["accountHash"] != account || stored["grant"]["accessToken"] != grant["accessToken"] {
        return Err("P4 授权已变化，请重新同步手表".into());
    }
    let expires = stored["savedAt"].as_f64().unwrap_or(0.)
        + super::readings::num(&grant["expiresIn"]).unwrap_or(0.);
    if !expires.is_finite() || expires * 1000. <= now as f64 + 30_000. {
        return Err("P4 授权已到期，请恢复连接后同步手表".into());
    }
    Ok((expires * 1000.) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watch_expiry_uses_original_issue_time_and_rejects_rotated_or_other_account_grants() {
        let grant = json!({"accessToken":"fixture","expiresIn":120});
        let stored = json!({"accountHash":"account","savedAt":1000,"grant":grant});
        assert_eq!(
            access_expiry(&stored, &grant, "account", 1_050_000).unwrap(),
            1_120_000
        );
        assert!(access_expiry(&stored, &grant, "account", 1_100_000).is_err());
        assert!(access_expiry(&stored, &grant, "other", 1_050_000).is_err());
        assert!(access_expiry(
            &stored,
            &json!({"accessToken":"rotated"}),
            "account",
            1_050_000
        )
        .is_err());
    }
}
