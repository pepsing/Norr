use super::{credentials, readings, Api, Method, Session, Value};
use crate::{now_ms, Result};
use serde_json::json;

const RECOVERY_INTERVAL: f64 = 60.;

fn complete(grant: &Value) -> bool {
    ["userId", "clientId", "refreshToken", "accessToken"]
        .iter()
        .all(|key| grant[*key].as_str().is_some_and(|v| !v.is_empty()))
        && readings::num(&grant["expiresIn"]).is_some_and(|n| n > 0. && n <= 31_536_000.)
}

fn same_user(previous: &Value, next: &Value) -> Result<()> {
    if previous["userId"].as_str().is_some_and(|v| !v.is_empty())
        && next
            .get("userId")
            .is_some_and(|v| !v.is_null() && v != "" && v != &previous["userId"])
    {
        return Err("P4 恢复返回的账号与当前账号不一致，请重新登录中国区账号".into());
    }
    Ok(())
}

impl Api<'_> {
    pub(super) async fn grant(&self, session: &Session, rejected: Option<&Value>) -> Result<Value> {
        #[cfg(test)]
        if let Some(store) = &self.sessions {
            let mut saved = store.lock().await;
            return self
                .grant_from_cache(session, rejected, saved.clone(), |value| {
                    *saved = value.clone();
                    Ok(())
                })
                .await;
        }
        let _lock = super::storage::lock()?;
        self.grant_from_cache(
            session,
            rejected,
            credentials::geely_session()?.unwrap_or_default(),
            credentials::save_geely,
        )
        .await
    }

    async fn grant_from_cache(
        &self,
        session: &Session,
        rejected: Option<&Value>,
        mut stored: Value,
        mut save: impl FnMut(&Value) -> Result<()>,
    ) -> Result<Value> {
        let scope = session.account_scope();
        let same_account = stored["accountHash"] == scope;
        let previous = if same_account {
            stored["grant"].clone()
        } else {
            Value::Null
        };
        if let Some(rejected) = rejected {
            if !same_account || rejected["userId"] != previous["userId"] {
                return Err("P4 账号会话已变化，请重新读取车辆".into());
            }
        }
        let now = now_ms() as f64 / 1000.;
        let new_login = stored["loginIssuedAt"]
            .as_f64()
            .is_some_and(|v| v != session.issued_at)
            || stored["recovery"]["loginIssuedAt"]
                .as_f64()
                .is_some_and(|v| v != session.issued_at);
        let recovering = same_account && !stored["recovery"].is_null();
        let legacy_rejection = same_account && !stored["reloginIssuedAt"].is_null();
        if same_account
            && !new_login
            && !recovering
            && !legacy_rejection
            && complete(&previous)
            && stored["savedAt"].as_f64().unwrap_or(0.)
                + readings::num(&previous["expiresIn"]).unwrap_or(0.)
                > now + 60.
            && rejected.is_none_or(|v| v["accessToken"] != previous["accessToken"])
        {
            return Ok(previous);
        }
        if recovering && !new_login {
            let attempted = stored["recovery"]["attemptedAt"].as_f64().unwrap_or(0.);
            if now >= attempted && now - attempted < RECOVERY_INTERVAL {
                return Err(format!(
                    "{}；请稍后重新连接",
                    stored["recovery"]["message"]
                        .as_str()
                        .unwrap_or("P4 会话正在恢复")
                ));
            }
        }
        let mut grant = None;
        if same_account && !new_login && !recovering && !legacy_rejection && complete(&previous) {
            match self
                .request(
                    Method::PUT,
                    "user-api",
                    "/auth/account/session/secure",
                    &[],
                    Some(json!({"refreshToken":previous["refreshToken"]})),
                    &previous,
                )
                .await
            {
                Ok(fresh) => {
                    same_user(&previous, &fresh)?;
                    if fresh["accessToken"].as_str().is_none_or(str::is_empty)
                        || readings::num(&fresh["expiresIn"])
                            .is_none_or(|n| n <= 0. || n > 31_536_000.)
                    {
                        return Err("P4 续期未返回有效的访问令牌或有效期".into());
                    }
                    let mut merged = previous.clone();
                    for (key, value) in fresh.as_object().ok_or("P4 续期格式无效")? {
                        // Optional identity fields may be absent or null in refresh responses.
                        if matches!(key.as_str(), "refreshToken" | "userId" | "clientId")
                            && value.as_str().is_none_or(str::is_empty)
                        {
                            continue;
                        }
                        merged[key] = value.clone();
                    }
                    grant = Some(merged);
                }
                Err(error) if error.authentication() => {}
                Err(error) => return Err(error.message("会话续期")),
            }
        }
        let grant = match grant {
            Some(grant) => grant,
            None => {
                let token = session
                    .login
                    .extra
                    .get("accessToken")
                    .and_then(Value::as_str)
                    .filter(|v| !v.is_empty())
                    .ok_or("缺少中国区外层授权，请重新登录中国区账号")?;
                stored = json!({"accountHash":scope,"grant":previous,"recovery":{
                    "loginIssuedAt":session.issued_at,"attemptedAt":now,"message":"P4 会话恢复尚未完成"
                }});
                // Persist before exchange so a restart cannot create an unbounded retry loop.
                save(&stored)?;
                let exchanged = self
                    .request(
                        Method::POST,
                        "user-api",
                        "/auth-center/account/session",
                        &[],
                        Some(json!({"identityType":"polestar","accessToken":token})),
                        &Value::Null,
                    )
                    .await
                    .map_err(|error| {
                        let message = error.message("会话恢复");
                        if error.authentication() {
                            format!("{message}，请重新登录中国区账号")
                        } else if matches!(
                            error,
                            super::error::RequestError::Response {
                                http: 400,
                                code: Some(6666),
                                ..
                            }
                        ) {
                            format!("{message}，可重新登录中国区账号后读取车辆")
                        } else {
                            message
                        }
                    })
                    .and_then(|grant| {
                        same_user(&previous, &grant)?;
                        if !complete(&grant) {
                            return Err("P4 服务未返回完整授权".into());
                        }
                        Ok(grant)
                    });
                match exchanged {
                    Ok(grant) => grant,
                    Err(error) => {
                        stored["recovery"]["message"] = json!(error);
                        save(&stored)?;
                        return Err(error);
                    }
                }
            }
        };
        save(
            &json!({"accountHash":scope,"loginIssuedAt":session.issued_at,"savedAt":now_ms() as f64 / 1000.,"grant":grant}),
        )?;
        Ok(grant)
    }
}

#[cfg(test)]
mod tests;
