use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Rejection {
    Access,
    Session,
    Signature,
    Other,
}

#[derive(Clone, Debug)]
pub(super) enum RequestError {
    Response {
        http: u16,
        code: Option<i64>,
        kind: Rejection,
    },
    Other(String),
}

impl RequestError {
    pub fn authentication(&self) -> bool {
        matches!(
            self,
            Self::Response {
                kind: Rejection::Access | Rejection::Session,
                ..
            }
        )
    }

    pub fn message(&self, operation: &str) -> String {
        match self {
            Self::Other(message) => message.clone(),
            Self::Response { http, code, kind } => {
                let reason = match kind {
                    Rejection::Access => "访问授权已失效",
                    Rejection::Session => "会话授权已失效",
                    Rejection::Signature => "签名校验未通过",
                    Rejection::Other => "请求未被接受",
                };
                let business = code.map(|v| format!("，业务码 {v}")).unwrap_or_default();
                format!("P4 {operation}{reason}（HTTP {http}{business}）")
            }
        }
    }
}

fn code(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_str()?.parse().ok())
}

pub(super) fn response(http: u16, data: Value) -> Result<Value, RequestError> {
    let business = code(&data["code"])
        .filter(|v| *v != 0)
        .or_else(|| code(&data["error"]["code"]));
    let kind = if http >= 500 {
        Rejection::Other
    } else {
        match business {
            Some(1402) => Rejection::Access,
            Some(1403 | 1404 | 1408) => Rejection::Session,
            Some(1440 | 1442 | 1443 | 1445 | 1446) => Rejection::Signature,
            None | Some(0 | 1000) if http == 401 => Rejection::Access,
            _ => Rejection::Other,
        }
    };
    if !(200..300).contains(&http)
        || kind != Rejection::Other
        || !data.is_object()
        || !data["error"].is_null()
        || data["success"] == false
        || data["isSuccess"] == false
        || data.get("code").is_some_and(|v| code(v) != Some(1000))
    {
        return Err(RequestError::Response {
            http,
            code: business,
            kind,
        });
    }
    Ok(if data.get("code").is_some() {
        data["data"].clone()
    } else {
        data
    })
}
