use bytes::{Buf, BufMut};
use std::time::Duration;
use tonic::codec::{Codec, DecodeBuf, Decoder, EncodeBuf, Encoder};
use tonic::transport::{Channel, ClientTlsConfig, Endpoint};
use tonic::{Request, Status};

pub const AUTH_ERROR: &str = "车辆服务拒绝当前授权，请恢复会话";

#[derive(Default, Clone)]
struct RawCodec;
impl Codec for RawCodec {
    type Encode = Vec<u8>;
    type Decode = Vec<u8>;
    type Encoder = Self;
    type Decoder = Self;
    fn encoder(&mut self) -> Self {
        Self
    }
    fn decoder(&mut self) -> Self {
        Self
    }
}
impl Encoder for RawCodec {
    type Item = Vec<u8>;
    type Error = Status;
    fn encode(
        &mut self,
        item: Self::Item,
        dst: &mut EncodeBuf<'_>,
    ) -> std::result::Result<(), Status> {
        dst.put_slice(&item);
        Ok(())
    }
}
impl Decoder for RawCodec {
    type Item = Vec<u8>;
    type Error = Status;
    fn decode(
        &mut self,
        src: &mut DecodeBuf<'_>,
    ) -> std::result::Result<Option<Self::Item>, Status> {
        Ok(Some(src.copy_to_bytes(src.remaining()).to_vec()))
    }
}

pub async fn channel(url: &str) -> crate::Result<Channel> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    let tls = ClientTlsConfig::new().with_webpki_roots();
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let tls = ClientTlsConfig::new().with_native_roots();
    Endpoint::from_shared(url.to_owned())
        .map_err(|_| "服务发现地址无效")?
        .tls_config(tls)
        .map_err(|_| "TLS 配置失败")?
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(25))
        .user_agent("grpc-java-okhttp/1.68.2")
        .map_err(|_| "连接配置失败")?
        .connect()
        .await
        .map_err(|_| "无法连接车辆服务，请检查网络".into())
}

pub async fn request(
    channel: Channel,
    path: &str,
    body: Vec<u8>,
    vin: &str,
    token: &str,
    first_only: bool,
) -> std::result::Result<Vec<u8>, Status> {
    let mut client = tonic::client::Grpc::new(channel).max_decoding_message_size(2_000_000);
    client
        .ready()
        .await
        .map_err(|_| Status::unavailable("车辆连接不可用"))?;
    let mut request = Request::new(body);
    request.metadata_mut().insert(
        "authorization",
        format!("Bearer {token}")
            .parse()
            .map_err(|_| Status::invalid_argument("会话格式无效"))?,
    );
    request.metadata_mut().insert(
        "vin",
        vin.parse()
            .map_err(|_| Status::invalid_argument("车辆身份无效"))?,
    );
    request.set_timeout(Duration::from_secs(25));
    let path = path
        .parse::<http::uri::PathAndQuery>()
        .map_err(|_| Status::invalid_argument("方法无效"))?;
    let mut stream = client
        .server_streaming(request, path, RawCodec)
        .await?
        .into_inner();
    let mut latest = None;
    while let Some(message) = stream.message().await? {
        latest = Some(message);
        if first_only {
            break;
        }
    }
    latest.ok_or_else(|| Status::data_loss("车辆服务返回空响应"))
}

pub fn error(status: Status) -> String {
    match status.code() {
        tonic::Code::Unauthenticated => AUTH_ERROR.into(),
        tonic::Code::PermissionDenied => "当前账号没有此服务权限".into(),
        tonic::Code::Unimplemented => "车辆服务尚未提供此接口".into(),
        tonic::Code::Unavailable => "车辆服务暂时不可用".into(),
        tonic::Code::DeadlineExceeded => "车辆响应超时，结果待核对".into(),
        code => format!("车辆请求未完成（gRPC {}）", code as i32),
    }
}
