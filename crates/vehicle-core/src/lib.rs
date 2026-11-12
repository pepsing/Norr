pub mod auth;
pub mod china;
pub mod confirmation;
pub mod credentials;
pub mod models;
pub mod schedules;
pub mod telemetry;
pub mod transport;
pub mod wire;

pub type Result<T> = std::result::Result<T, String>;

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
