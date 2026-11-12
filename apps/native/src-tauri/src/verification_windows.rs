use norr_vehicle_core::{auth::Verification, Result};
use std::sync::Mutex;
use tauri::{Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;

const PAGE: &str = "https://h5.app.polestar-auto.com/account-components/auth-slider/index.html";
type Completion = oneshot::Sender<Option<Verification>>;

#[derive(Default)]
pub struct Pending(Mutex<Option<(String, Completion)>>);

fn official_page(url: &tauri::Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("h5.app.polestar-auto.com")
        && url.path() == "/account-components/auth-slider/index.html"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
}

fn parse_payload(text: &str) -> Result<Verification> {
    if text.len() > 16_384 {
        return Err("验证结果过大".into());
    }
    let json = if text.trim_start().starts_with('{') {
        text.to_owned()
    } else {
        let url = tauri::Url::parse(text).map_err(|_| "验证结果格式无效")?;
        if url.scheme() != "polestar"
            || url.host_str() != Some("webview")
            || url.path() != "/autoAccount"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || url.fragment().is_some()
        {
            return Err("验证回调地址无效".into());
        }
        url.query_pairs()
            .find(|(name, _)| name == "data")
            .map(|(_, value)| value.into_owned())
            .ok_or("验证回调缺少结果")?
    };
    let proof: Verification = serde_json::from_str(&json).map_err(|_| "验证结果格式无效")?;
    proof.validate()?;
    Ok(proof)
}

#[tauri::command]
pub async fn submit_verification(
    window: WebviewWindow,
    state: State<'_, Pending>,
    payload: Option<String>,
) -> Result<()> {
    if !official_page(&window.url().map_err(|_| "无法确认验证页面")?) {
        return Err("验证页面来源无效".into());
    }
    let mut pending = state.0.lock().map_err(|_| "验证状态不可用")?;
    if pending.as_ref().map(|(label, _)| label.as_str()) != Some(window.label()) {
        return Err("此验证窗口已失效".into());
    }
    let verification = payload.as_deref().map(parse_payload).transpose()?;
    if let Some((_, sender)) = pending.take() {
        let _ = sender.send(verification);
    }
    Ok(())
}

const BRIDGE: &str = r#"
if (window === window.top && location.origin === 'https://h5.app.polestar-auto.com') {
  const submit = payload => window.__TAURI_INTERNALS__.invoke('submit_verification', { payload });
  const receive = message => submit(String(message)).catch(() => {
    const status = document.getElementById('norr-verification-status');
    if (status) status.textContent = '验证结果无效，请重新加载后重试。';
  });
  window.chromium = { postMessage: receive };
  const handlers = { chinaVerification: { postMessage: receive }, dispatch: { postMessage: receive } };
  window.webkit = { messageHandlers: handlers };
  document.addEventListener('DOMContentLoaded', () => {
    const controls = document.createElement('div');
    controls.style.cssText = 'position:fixed;bottom:0;left:0;right:0;padding:16px 20px;background:#f7f7f5;color:#20221f;font:14px system-ui;z-index:2147483647;';
    const status = document.createElement('p');
    status.id = 'norr-verification-status';
    status.textContent = '完成验证后会向所填手机号发送短信。';
    controls.appendChild(status);
    for (const [label, action] of [['重新加载', () => location.reload()], ['取消', () => submit(null)]]) {
      const button = document.createElement('button');
      button.textContent = label;
      button.style.cssText = 'padding:8px 16px;margin-right:12px;font:inherit;cursor:pointer;';
      button.addEventListener('click', action);
      controls.appendChild(button);
    }
    document.body.appendChild(controls);
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') submit(null); });
}
"#;

pub async fn verify(parent: &WebviewWindow) -> Result<Option<Verification>> {
    let app = parent.app_handle();
    let label = format!("phone-verification-{}", uuid::Uuid::new_v4());
    let (sender, receiver) = oneshot::channel();
    let state = app.state::<Pending>();
    {
        let mut pending = state.0.lock().map_err(|_| "验证状态不可用")?;
        if pending.is_some() {
            return Err("请先完成或关闭当前验证窗口".into());
        }
        *pending = Some((label.clone(), sender));
    }
    let built = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::External(PAGE.parse().expect("verification URL")),
    )
    .title("Polestar 手机验证")
    .inner_size(520.0, 420.0)
    .resizable(false)
    .incognito(true)
    .initialization_script(BRIDGE)
    .on_navigation(official_page)
    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
    .parent(parent)
    .and_then(|builder| builder.build());
    let window = match built {
        Ok(window) => window,
        Err(_) => {
            if let Ok(mut pending) = state.0.lock() {
                pending.take();
            }
            return Err("无法打开手机验证窗口，请确认 WebView2 已安装".into());
        }
    };
    let handle = app.clone();
    let closed_label = label.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let state = handle.state::<Pending>();
            if let Ok(mut pending) = state.0.lock() {
                if pending.as_ref().map(|(label, _)| label) == Some(&closed_label) {
                    if let Some((_, sender)) = pending.take() {
                        let _ = sender.send(None);
                    }
                }
            };
        }
    });
    let result = tokio::time::timeout(std::time::Duration::from_secs(300), receiver).await;
    if let Ok(mut pending) = state.0.lock() {
        pending.take();
    }
    let _ = window.destroy();
    let _ = parent.set_focus();
    result
        .map_err(|_| "验证已超时，请重新获取验证码")?
        .map_err(|_| "验证窗口已关闭".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callback_accepts_official_proofs_and_rejects_other_sources() {
        let json = r#"{"sessionId":"fixture-session","sig":"fixture-sig","token":"fixture-token"}"#;
        assert!(parse_payload(json).is_ok());
        let mut callback = tauri::Url::parse("polestar://webview/autoAccount").unwrap();
        callback.query_pairs_mut().append_pair("data", json);
        assert!(parse_payload(callback.as_str()).is_ok());
        assert!(parse_payload("{}").is_err());
        assert!(parse_payload(&callback.to_string().replace("webview", "other")).is_err());
        assert!(official_page(&PAGE.parse().unwrap()));
        assert!(!official_page(
            &PAGE.replace("https:", "http:").parse().unwrap()
        ));
        assert!(!official_page(
            &PAGE
                .replace("polestar-auto.com", "polestar-auto.com.evil.test")
                .parse()
                .unwrap()
        ));
    }
}
