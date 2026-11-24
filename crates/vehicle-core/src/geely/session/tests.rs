use super::*;
use crate::geely::{error, VehicleRead};
use reqwest::Client;
use ring::hmac;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::Arc,
    thread,
    time::Duration,
};
use tokio::sync::Mutex;

fn grant() -> Value {
    json!({"accessToken":"fixture-old","refreshToken":"fixture-refresh","userId":"fixture-user","clientId":"fixture-client","expiresIn":7200})
}

fn login(issued_at: f64) -> Session {
    serde_json::from_value(json!({"issuedAt":issued_at,"globalIssuedAt":issued_at,"login":{
        "userUid":"fixture-account","accessToken":"fixture-outer","globleToken":{
            "accessToken":"fixture-global","refreshToken":"fixture-global-refresh","tokenType":"bearer","expiresIn":7200
        }
    }})).unwrap()
}

fn cache() -> Value {
    json!({"accountHash":login(100.).account_scope(),"savedAt":0,"grant":grant()})
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

fn server(responses: Vec<Option<(u16, Value)>>) -> (String, thread::JoinHandle<Vec<String>>) {
    server_with_initial_batch(responses, 1)
}

fn server_with_initial_batch(
    responses: Vec<Option<(u16, Value)>>,
    initial_batch: usize,
) -> (String, thread::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let worker = thread::spawn(move || {
        let mut requests = Vec::new();
        let mut pending = Vec::new();
        for response in responses {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            std::time::Instant::now() < deadline,
                            "expected request was not sent"
                        );
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(e) => panic!("{e}"),
                }
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = Vec::new();
            loop {
                let mut buffer = [0u8; 4096];
                let n = socket.read(&mut buffer).unwrap();
                assert!(n > 0);
                request.extend_from_slice(&buffer[..n]);
                if let Some(end) = request.windows(4).position(|v| v == b"\r\n\r\n") {
                    let length: usize = String::from_utf8_lossy(&request[..end])
                        .lines()
                        .find_map(|line| {
                            let (key, value) = line.split_once(':')?;
                            key.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse().unwrap())
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            requests.push(String::from_utf8(request).unwrap());
            pending.push((socket, response));
            if requests.len() >= initial_batch {
                for (mut socket, response) in pending.drain(..) {
                    if let Some((status, data)) = response {
                        let body = data.to_string();
                        write!(socket,"HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
                    }
                }
            }
        }
        requests
    });
    (endpoint, worker)
}

fn success(data: Value) -> Option<(u16, Value)> {
    Some((200, json!({"code":1000,"data":data})))
}

fn client() -> Client {
    Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap()
}

fn make_api(http: &Client, endpoint: String, stored: Value) -> Api<'_> {
    Api {
        http,
        key: hmac::Key::new(hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, b"fixture-secret"),
        device: "fixture-device".into(),
        endpoint: Some(endpoint),
        sessions: Some(Arc::new(Mutex::new(stored))),
    }
}

#[test]
fn response_codes_keep_http_evidence_and_separate_authentication() {
    for (http, data, auth, text) in [
        (200, json!({"code":1402}), true, "HTTP 200，业务码 1402"),
        (
            200,
            json!({"error":{"code":"1402"}}),
            true,
            "HTTP 200，业务码 1402",
        ),
        (401, Value::Null, true, "HTTP 401"),
        (
            200,
            json!({"code":0,"error":{"code":1403}}),
            true,
            "业务码 1403",
        ),
        (200, json!({"code":"1404"}), true, "业务码 1404"),
        (403, json!({"error":{"code":1408}}), true, "业务码 1408"),
        (401, json!({"error":{"code":1440}}), false, "签名校验未通过"),
        (500, json!({"code":1402}), false, "HTTP 500"),
        (403, json!({"code":1500}), false, "业务码 1500"),
        (400, json!({"code":6666}), false, "HTTP 400，业务码 6666"),
    ] {
        let error = error::response(http, data).unwrap_err();
        assert_eq!(error.authentication(), auth);
        assert!(error.message("读取").contains(text));
    }
}

#[test]
fn successful_renewal_preserves_optional_fields_and_does_not_use_global_token() {
    let (endpoint, worker) = server(vec![success(
        json!({"accessToken":"fixture-new","expiresIn":7200,"refreshToken":null,"clientId":"","userId":null}),
    )]);
    let http = client();
    let api = make_api(&http, endpoint, cache());
    let next = runtime().block_on(api.grant(&login(100.), None)).unwrap();
    assert_eq!(next["refreshToken"], "fixture-refresh");
    assert_eq!(next["clientId"], "fixture-client");
    assert_eq!(next["userId"], "fixture-user");
    assert_eq!(next["accessToken"], "fixture-new");
    let requests = worker.join().unwrap();
    assert!(requests[0].starts_with("PUT /auth/account/session/secure "));
    assert!(requests[0]
        .to_lowercase()
        .contains("authorization: fixture-old\r\n"));
    assert!(requests[0]
        .to_lowercase()
        .contains("x-client-id: fixture-client\r\n"));
    assert!(requests[0].ends_with(r#"{"refreshToken":"fixture-refresh"}"#));
    assert!(!requests[0].contains("fixture-global"));
}

#[test]
fn incomplete_or_changed_renewal_does_not_replace_saved_credentials() {
    for fresh in [
        json!({"accessToken":"","expiresIn":7200}),
        json!({"accessToken":"fixture-new","expiresIn":0}),
        json!({"accessToken":"fixture-new","expiresIn":7200,"userId":"different-user"}),
    ] {
        let (endpoint, worker) = server(vec![success(fresh)]);
        let http = client();
        let api = make_api(&http, endpoint, cache());
        let rt = runtime();
        assert!(rt.block_on(api.grant(&login(100.), None)).is_err());
        assert_eq!(*rt.block_on(api.sessions.as_ref().unwrap().lock()), cache());
        assert_eq!(worker.join().unwrap().len(), 1);
    }
}

#[test]
fn rejected_renewal_exchanges_once_then_retries_only_the_read() {
    let mut renewed = grant();
    renewed["accessToken"] = json!("fixture-exchanged");
    let (endpoint, worker) = server(vec![
        Some((200, json!({"error":{"code":1402}}))),
        Some((401, json!({"error":{"code":1403}}))),
        success(renewed),
        success(json!({"value":42})),
    ]);
    let http = client();
    let api = make_api(&http, endpoint, cache());
    let session = login(100.);
    let reader = VehicleRead {
        api: &api,
        session: &session,
        grant: grant(),
        renewed: Default::default(),
    };
    assert_eq!(
        runtime()
            .block_on(reader.get("device-api", "/fixture", &[]))
            .unwrap()["value"],
        42
    );
    let requests = worker.join().unwrap();
    assert_eq!(requests.len(), 4);
    assert!(requests[1].starts_with("PUT /auth/account/session/secure "));
    assert!(requests[2].starts_with("POST /auth-center/account/session "));
    assert!(!requests[2].to_lowercase().contains("authorization:"));
    assert!(requests[2].ends_with(r#"{"accessToken":"fixture-outer","identityType":"polestar"}"#));
    assert!(requests[3]
        .to_lowercase()
        .contains("authorization: fixture-exchanged\r\n"));
}

#[test]
fn legacy_rejection_recovers_without_sms_and_saves_a_reusable_grant() {
    let mut stored = cache();
    stored["reloginIssuedAt"] = json!(100.);
    let (endpoint, worker) = server(vec![success(grant())]);
    let http = client();
    let api = make_api(&http, endpoint, stored);
    let rt = runtime();
    rt.block_on(api.grant(&login(100.), None)).unwrap();
    let saved = rt.block_on(api.sessions.as_ref().unwrap().lock()).clone();
    assert!(saved["reloginIssuedAt"].is_null());
    assert!(saved["recovery"].is_null());
    assert_eq!(saved["loginIssuedAt"], 100.);
    rt.block_on(api.grant(&login(100.), None)).unwrap();
    assert!(worker.join().unwrap()[0].starts_with("POST /auth-center/account/session "));
}

#[test]
fn recovery_failure_survives_restart_with_a_bounded_retry_and_preserves_credentials() {
    let mut stored = cache();
    stored["reloginIssuedAt"] = json!(100.);
    let (endpoint, worker) = server(vec![Some((401, json!({"code":1404}))), success(grant())]);
    let http = client();
    let api = make_api(&http, endpoint, stored);
    let rt = runtime();
    let error = rt.block_on(api.grant(&login(100.), None)).unwrap_err();
    assert!(error.contains("请重新登录中国区账号"));
    let saved = rt.block_on(api.sessions.as_ref().unwrap().lock()).clone();
    assert_eq!(saved["grant"], grant());
    let restarted = make_api(&http, api.endpoint.clone().unwrap(), saved);
    assert!(rt
        .block_on(restarted.grant(&login(100.), None))
        .unwrap_err()
        .contains("请稍后重新连接"));
    rt.block_on(restarted.sessions.as_ref().unwrap().lock())["recovery"]["attemptedAt"] = json!(0);
    rt.block_on(restarted.grant(&login(100.), None)).unwrap();
    assert_eq!(worker.join().unwrap().len(), 2);
}

#[test]
fn new_login_bypasses_recovery_cooldown() {
    let mut stored = cache();
    stored["recovery"] =
        json!({"loginIssuedAt":100.,"attemptedAt":now_ms() as f64/1000.,"message":"fixture"});
    let (endpoint, worker) = server(vec![success(grant())]);
    let http = client();
    let api = make_api(&http, endpoint, stored);
    runtime().block_on(api.grant(&login(200.), None)).unwrap();
    assert!(worker.join().unwrap()[0].starts_with("POST /auth-center/account/session "));
}

#[test]
fn network_server_and_signature_errors_do_not_exchange_or_poison_the_session() {
    for response in [
        None,
        Some((503, json!({"code":1402}))),
        Some((401, json!({"error":{"code":1442}}))),
    ] {
        let (endpoint, worker) = server(vec![response]);
        let http = client();
        let api = make_api(&http, endpoint, cache());
        let rt = runtime();
        assert!(rt.block_on(api.grant(&login(100.), None)).is_err());
        assert_eq!(*rt.block_on(api.sessions.as_ref().unwrap().lock()), cache());
        assert_eq!(worker.join().unwrap().len(), 1);
    }
}

#[test]
fn changed_identity_or_account_cannot_resume_an_old_request() {
    let mut stored = cache();
    stored["accountHash"] = json!("different-account");
    let http = client();
    let api = make_api(&http, "http://127.0.0.1:1".into(), stored);
    assert!(runtime()
        .block_on(api.grant(&login(100.), Some(&grant())))
        .unwrap_err()
        .contains("账号会话已变化"));
    let mut other = grant();
    other["userId"] = json!("different-user");
    let mut stored = cache();
    stored["reloginIssuedAt"] = json!(100.);
    let (endpoint, worker) = server(vec![success(other)]);
    let api = make_api(&http, endpoint, stored);
    let rt = runtime();
    assert!(rt
        .block_on(api.grant(&login(100.), None))
        .unwrap_err()
        .contains("账号与当前账号不一致"));
    assert_eq!(
        rt.block_on(api.sessions.as_ref().unwrap().lock())["grant"],
        grant()
    );
    worker.join().unwrap();
}

#[test]
fn concurrent_read_failures_share_one_renewal() {
    let expired = Some((200, json!({"error":{"code":1402}})));
    let read = success(json!({"value":1}));
    let (endpoint, worker) = server_with_initial_batch(
        vec![
            expired.clone(),
            expired.clone(),
            expired,
            success(json!({"accessToken":"fixture-new","expiresIn":7200})),
            read.clone(),
            read.clone(),
            read,
        ],
        3,
    );
    let http = client();
    let api = make_api(&http, endpoint, cache());
    let session = login(100.);
    let reader = VehicleRead {
        api: &api,
        session: &session,
        grant: grant(),
        renewed: Default::default(),
    };
    let result = runtime().block_on(async {
        tokio::join!(
            reader.get("device-api", "/a", &[]),
            reader.get("device-api", "/b", &[]),
            reader.get("device-api", "/c", &[])
        )
    });
    assert!(result.0.is_ok() && result.1.is_ok() && result.2.is_ok());
    let requests = worker.join().unwrap();
    assert_eq!(requests.iter().filter(|r| r.starts_with("PUT ")).count(), 1);
    assert_eq!(
        requests
            .iter()
            .filter(|r| r.to_lowercase().contains("authorization: fixture-new\r\n"))
            .count(),
        3
    );
}

#[test]
fn read_still_rejected_after_recovery_stops_without_a_second_renewal() {
    let (endpoint, worker) = server(vec![
        Some((200, json!({"code":1402}))),
        success(json!({"accessToken":"fixture-new","expiresIn":7200})),
        Some((403, json!({"error":{"code":1408}}))),
    ]);
    let http = client();
    let api = make_api(&http, endpoint, cache());
    let session = login(100.);
    let reader = VehicleRead {
        api: &api,
        session: &session,
        grant: grant(),
        renewed: Default::default(),
    };
    let error = runtime()
        .block_on(reader.get("device-api", "/fixture", &[]))
        .unwrap_err();
    assert!(error.contains("HTTP 403，业务码 1408"));
    assert!(error.contains("车辆访问权限"));
    assert_eq!(worker.join().unwrap().len(), 3);
}
