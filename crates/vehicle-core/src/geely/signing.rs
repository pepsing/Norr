use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{Method, Url};
use ring::hmac;

pub(super) const ACCEPT: &str = "application/json";

pub(super) fn set_query(url: &mut Url, params: &[(&str, &str)]) {
    let mut params = params.to_vec();
    params.sort_unstable();
    if !params.is_empty() {
        url.query_pairs_mut().extend_pairs(params);
    }
    if let Some(query) = url.query() {
        let query = query
            .replace('+', "%20")
            .replace('*', "%2A")
            .replace("%7E", "~")
            .replace(',', "%2C");
        url.set_query(Some(&query));
    }
}

pub(super) fn signature(
    key: &hmac::Key,
    url: &Url,
    body: &[u8],
    timestamp: u64,
    nonce: &str,
    method: &Method,
) -> String {
    let digest = STANDARD.encode(md5::compute(body).0);
    let source = format!(
        "{ACCEPT}\nx-api-signature-nonce:{nonce}\nx-api-signature-version:1.0\n\n{}\n{digest}\n{timestamp}\n{method}\n{}",
        url.query().unwrap_or(""),
        url.path(),
    );
    STANDARD.encode(hmac::sign(key, source.as_bytes()).as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_key() -> hmac::Key {
        hmac::Key::new(hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, b"fixture-secret")
    }

    #[test]
    fn signature_matches_independent_probe_fixture() {
        let mut url = Url::parse(
            "https://device-api.xchanger.cn/remote-control/vehicle/status/TEST1234567890123",
        )
        .unwrap();
        set_query(
            &mut url,
            &[("userId", "test user"), ("target", ""), ("latest", "true")],
        );
        assert_eq!(
            signature(
                &fixture_key(),
                &url,
                b"",
                1700000000000,
                "fixture-nonce",
                &Method::GET
            ),
            "aV+SgF7vyIjxgsMRBpWqh8OvvWI="
        );
    }

    #[test]
    fn query_encodes_special_characters_once_and_preserves_empty_values() {
        let mut url = Url::parse("https://device-api.xchanger.cn/test").unwrap();
        set_query(&mut url, &[("z", ""), ("q", "a b+*~%,&=北")]);
        assert_eq!(url.query(), Some("q=a%20b%2B%2A~%25%2C%26%3D%E5%8C%97&z="));
        assert_eq!(url.query_pairs().next().unwrap().1, "a b+*~%,&=北");
    }

    #[test]
    fn signature_covers_body_method_timestamp_nonce_and_path() {
        let url = Url::parse("https://user-api.xchanger.cn/auth-center/account/session").unwrap();
        let key = fixture_key();
        let body = br#"{"identityType":"polestar","accessToken":"fixture"}"#;
        let signed = signature(
            &key,
            &url,
            body,
            1700000000000,
            "fixture-nonce",
            &Method::POST,
        );
        assert_eq!(signed, "bc3WgfAUBbkUV9eotz9vVkBu6FU=");
        assert_ne!(
            signed,
            signature(
                &key,
                &url,
                b"{}",
                1700000000000,
                "fixture-nonce",
                &Method::POST
            )
        );
        assert_ne!(
            signed,
            signature(
                &key,
                &url,
                body,
                1700000000000,
                "fixture-nonce",
                &Method::PUT
            )
        );
        assert_ne!(
            signed,
            signature(
                &key,
                &url,
                body,
                1700000000001,
                "fixture-nonce",
                &Method::POST
            )
        );
        assert_ne!(
            signed,
            signature(
                &key,
                &url,
                body,
                1700000000000,
                "other-nonce",
                &Method::POST
            )
        );
        let other = Url::parse("https://user-api.xchanger.cn/auth/account/session/secure").unwrap();
        assert_ne!(
            signed,
            signature(
                &key,
                &other,
                body,
                1700000000000,
                "fixture-nonce",
                &Method::POST
            )
        );
    }
}
