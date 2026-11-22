use super::{Backend, Result};

pub(super) async fn log_scope(backend: &mut Backend, vin: &str) -> Result<String> {
    let owned = backend.client.vehicles().await?.iter().any(|car| {
        car.vin == vin
            && car
                .platform
                .as_deref()
                .is_some_and(|p| p.eq_ignore_ascii_case("HUANFU"))
    });
    if !owned {
        return Err("请在当前账号的车库中选择 Polestar 4".into());
    }
    let account = backend.client.account_scope().ok_or("请先登录")?;
    Ok(format!("{account}/{vin}"))
}
