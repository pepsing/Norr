//! Local diagnostic CLI for the China vehicle core.
//!
//! ```sh
//! cargo run -p norr-vehicle-core --example probe -- --status
//! cargo run -p norr-vehicle-core --example probe -- --fleet
//! cargo run -p norr-vehicle-core --example probe -- --probe <VIN>
//! printf '%s' "$KEY" | cargo run -p norr-vehicle-core --example probe -- --set-key
//! ```
//!
//! The macOS keychain prompt belongs to this binary. Nothing is uploaded; the
//! report is printed to stdout and may contain the VIN and vehicle location.

use norr_vehicle_core::{
    china::ChinaClient, confirmation, credentials, models::Command, xchanger::XchangerClient,
    Result,
};
use std::io::Read;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("--status") => status(),
        Some("--set-key") => set_key(),
        Some("--fleet") => block(fleet()),
        Some("--probe") => match args.get(1) {
            Some(vin) => block(probe(vin)),
            None => Err("用法：--probe <17 位 VIN>".into()),
        },
        Some("--set-xchanger") => set_xchanger(),
        Some("--xchanger-exchange") => block(xchanger_exchange(None)),
        Some("--geocode") => match (args.get(1), args.get(2)) {
            (Some(lat), Some(lon)) => match (lat.parse::<f64>(), lon.parse::<f64>()) {
                (Ok(lat), Ok(lon)) => block(geocode(lat, lon)),
                _ => Err("用法：--geocode <纬度> <经度>".into()),
            },
            _ => Err("用法：--geocode <纬度> <经度>".into()),
        },
        Some("--xchanger-exchange-token") => match args.get(1) {
            Some(path) => block(xchanger_exchange(Some(path))),
            None => Err("用法：--xchanger-exchange-token <文件>".into()),
        },
        Some("--xchanger-set-target") => match (args.get(1), args.get(2)) {
            (Some(percent), Some(vin)) => match percent.parse::<f64>() {
                Ok(percent) => block(xchanger_set_target(vin, percent)),
                Err(_) => Err("用法：--xchanger-set-target <百分比> <VIN>".into()),
            },
            _ => Err("用法：--xchanger-set-target <百分比> <VIN>".into()),
        },
        Some("--xchanger-target") => match args.get(1) {
            Some(vin) => block(xchanger_target(vin)),
            None => Err("用法：--xchanger-target <17 位 VIN>".into()),
        },
        Some("--xchanger-status") => match args.get(1) {
            Some(vin) => block(xchanger_status(vin)),
            None => Err("用法：--xchanger-status <17 位 VIN>".into()),
        },
        Some("--xchanger-climate") => match (args.get(1), args.get(2)) {
            (Some(command), Some(vin)) => {
                let confirmed = args.iter().any(|arg| arg == "--yes");
                block(xchanger_climate(vin, command, confirmed))
            }
            _ => Err("用法：--xchanger-climate <start|stop> <VIN> [--yes]".into()),
        },
        Some("--location-variants") => match args.get(1) {
            Some(vin) => block(location_variants(vin)),
            None => Err("用法：--location-variants <17 位 VIN>".into()),
        },
        Some("--discovery") => block(discovery()),
        Some("--availability") => match args.get(1) {
            Some(vin) => block(availability(vin)),
            None => Err("用法：--availability <17 位 VIN>".into()),
        },
        Some("--ping") => match args.get(1) {
            Some(vin) => block(ping(vin)),
            None => Err("用法：--ping <17 位 VIN>".into()),
        },
        Some("--snapshot") => match args.get(1) {
            Some(vin) => block(snapshot(vin)),
            None => Err("用法：--snapshot <17 位 VIN>".into()),
        },
        Some("--command") => command_args(&args),
        _ => usage(),
    };
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn set_xchanger() -> Result<()> {
    let mut value = String::new();
    std::io::stdin()
        .read_to_string(&mut value)
        .map_err(|_| "无法读取标准输入")?;
    credentials::save_xchanger_token(&value)?;
    println!("xchanger 令牌已写入本机凭据存储。");
    Ok(())
}

async fn geocode(latitude: f64, longitude: f64) -> Result<()> {
    println!(
        "{}",
        norr_vehicle_core::geocode::reverse(latitude, longitude).await?
    );
    Ok(())
}

async fn xchanger_exchange(path: Option<&String>) -> Result<()> {
    let access = match path {
        Some(path) => std::fs::read_to_string(path)
            .map_err(|_| "无法读取 Polestar 令牌文件")?
            .trim()
            .to_owned(),
        None => credentials::load_session()?
            .ok_or("请先登录 Polestar 账号")?
            .login
            .extra
            .get("accessToken")
            .and_then(|value| value.as_str())
            .ok_or("会话缺少 Polestar 网关令牌")?
            .to_owned(),
    };
    let existing = credentials::xchanger_token()?;
    let client =
        XchangerClient::exchange(&access, existing.as_ref().map(|value| value.as_str())).await?;
    credentials::save_xchanger_token(client.token())?;
    println!("xchanger 用户 {}", client.user_id());
    Ok(())
}

fn xchanger_client() -> Result<XchangerClient> {
    let token = credentials::xchanger_token()?
        .ok_or("本机没有 xchanger 令牌，请先用 --set-xchanger 写入")?;
    XchangerClient::from_token(&token)
}

async fn xchanger_set_target(vin: &str, percent: f64) -> Result<()> {
    let client = xchanger_client()?;
    let result = client.set_target_soc(vin, percent).await?;
    println!(
        "指令已提交：{}",
        serde_json::to_string(&result).unwrap_or_default()
    );
    tokio::time::sleep(std::time::Duration::from_secs(4)).await;
    println!("回读目标电量 {}%", client.target_soc(vin).await?);
    Ok(())
}

async fn xchanger_target(vin: &str) -> Result<()> {
    let client = xchanger_client()?;
    println!("目标电量 {}%", client.target_soc(vin).await?);
    Ok(())
}

async fn xchanger_status(vin: &str) -> Result<()> {
    let client = xchanger_client()?;
    let status = client.status(vin).await?;
    let position = &status["basicVehicleStatus"]["position"];
    let latitude = norr_vehicle_core::xchanger::coordinate(&position["latitude"]);
    let longitude = norr_vehicle_core::xchanger::coordinate(&position["longitude"]);
    println!(
        "位置 {} / {}（alt {}，mars {}）",
        latitude
            .map(|value| format!("{value:.6}"))
            .unwrap_or_default(),
        longitude
            .map(|value| format!("{value:.6}"))
            .unwrap_or_default(),
        position["altitude"].as_str().unwrap_or("?"),
        position["marsCoordinates"].as_str().unwrap_or("?")
    );
    println!(
        "电量 {}%，续航 {} km，空调 {}，车内 {} ℃",
        status["additionalVehicleStatus"]["electricVehicleStatus"]["chargeLevel"]
            .as_str()
            .unwrap_or("?"),
        status["additionalVehicleStatus"]["electricVehicleStatus"]["distanceToEmptyOnBatteryOnly"]
            .as_str()
            .unwrap_or("?"),
        status["additionalVehicleStatus"]["climateStatus"]["preClimateActive"],
        status["additionalVehicleStatus"]["climateStatus"]["interiorTemp"]
            .as_str()
            .unwrap_or("?")
    );
    println!(
        "{}",
        serde_json::to_string_pretty(&status).map_err(|_| "状态编码失败")?
    );
    Ok(())
}

async fn xchanger_climate(vin: &str, command: &str, confirmed: bool) -> Result<()> {
    if !matches!(command, "start" | "stop") {
        return Err("空调指令只能是 start 或 stop".into());
    }
    if !confirmed {
        println!("dry-run：加 --yes 才会发送空调{command}。");
        return Ok(());
    }
    let client = xchanger_client()?;
    let duration = if command == "start" { 180 } else { 0 };
    let result = client
        .control(
            vin,
            "RCE_2",
            command,
            &[("rce.conditioner", "1"), ("rce.temp", "22")],
            duration,
        )
        .await?;
    println!(
        "指令已提交：{}",
        serde_json::to_string(&result).unwrap_or_default()
    );
    let target = command == "start";
    for attempt in 1..=15 {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        let status = client.status(vin).await?;
        let active = status["additionalVehicleStatus"]["climateStatus"]["preClimateActive"]
            .as_str()
            .map(|value| value == "true")
            .unwrap_or(false);
        println!(
            "回读 {attempt}/15：preClimateActive={active} interiorTemp={}",
            status["additionalVehicleStatus"]["climateStatus"]["interiorTemp"]
                .as_str()
                .unwrap_or("?")
        );
        if active == target {
            return Ok(());
        }
    }
    println!("车辆尚未回读目标状态，请在官方 App 或车内确认。");
    Ok(())
}

fn command_args(args: &[String]) -> Result<()> {
    let action = args
        .get(1)
        .ok_or("用法：--command <action> <VIN> [--value N] [--yes]")?;
    let vin = args
        .get(2)
        .ok_or("用法：--command <action> <VIN> [--value N] [--yes]")?;
    let value = args
        .iter()
        .position(|arg| arg == "--value")
        .and_then(|index| args.get(index + 1))
        .and_then(|value| value.parse::<f64>().ok());
    let confirmed = args.iter().any(|arg| arg == "--yes");
    let raw = args.iter().any(|arg| arg == "--raw");
    block(command(vin, action, value, confirmed, raw))
}

fn block<F>(future: F) -> Result<()>
where
    F: std::future::Future<Output = Result<()>>,
{
    tokio::runtime::Runtime::new()
        .map_err(|_| "无法建立异步运行时".to_string())?
        .block_on(future)
}

fn status() -> Result<()> {
    let status = credentials::status()?;
    println!(
        "{}",
        serde_json::to_string_pretty(&status).map_err(|_| "状态编码失败")?
    );
    Ok(())
}

fn set_key() -> Result<()> {
    let mut value = String::new();
    std::io::stdin()
        .read_to_string(&mut value)
        .map_err(|_| "无法读取标准输入")?;
    credentials::save_signing_key(&value)?;
    println!("签名配置已写入本机凭据存储。");
    Ok(())
}

async fn fleet() -> Result<()> {
    let mut client = ChinaClient::new()?;
    let vehicles = client.connect().await?;
    let summary = vehicles
        .iter()
        .map(|vehicle| {
            serde_json::json!({
                "vin": vehicle.vin,
                "model": vehicle.model,
                "modelYear": vehicle.model_year,
                "platform": vehicle.platform,
                "owner": vehicle.owner,
                "installedVersion": vehicle.installed_version,
                "capabilities": vehicle.capabilities,
                "limits": vehicle.limits,
            })
        })
        .collect::<Vec<_>>();
    println!(
        "{}",
        serde_json::to_string_pretty(&summary).map_err(|_| "车队编码失败")?
    );
    Ok(())
}

async fn probe(vin: &str) -> Result<()> {
    let mut client = ChinaClient::new()?;
    client.set_experimental(true);
    let report = client.probe(vin).await?;
    println!(
        "{}",
        serde_json::to_string_pretty(&report).map_err(|_| "探测结果编码失败")?
    );
    Ok(())
}

async fn location_variants(vin: &str) -> Result<()> {
    let mut client = ChinaClient::new()?;
    client.set_experimental(true);
    println!(
        "{}",
        serde_json::to_string_pretty(&client.location_variants(vin).await?)
            .map_err(|_| "位置结果编码失败")?
    );
    Ok(())
}

async fn discovery() -> Result<()> {
    let mut client = ChinaClient::new()?;
    println!(
        "{}",
        serde_json::to_string_pretty(&client.discovery().await?).map_err(|_| "服务发现编码失败")?
    );
    Ok(())
}

async fn availability(vin: &str) -> Result<()> {
    let mut client = ChinaClient::new()?;
    client.set_experimental(true);
    println!(
        "{}",
        serde_json::to_string_pretty(&client.availability(vin).await?)
            .map_err(|_| "可用性编码失败")?
    );
    Ok(())
}

async fn ping(vin: &str) -> Result<()> {
    let mut client = ChinaClient::new()?;
    client.set_experimental(true);
    let (status, message) = client.ping(vin).await?;
    println!("通道回执：{status} · {message}");
    Ok(())
}

async fn snapshot(vin: &str) -> Result<()> {
    let mut client = ChinaClient::new()?;
    client.set_experimental(true);
    let snapshot = client.refresh(vin).await?;
    println!(
        "{}",
        serde_json::to_string_pretty(&snapshot).map_err(|_| "快照编码失败")?
    );
    Ok(())
}

async fn command(
    vin: &str,
    action: &str,
    value: Option<f64>,
    confirmed: bool,
    raw: bool,
) -> Result<()> {
    if matches!(action, "flash" | "honkFlash" | "honk") {
        return Err("按当前测试约定，不发送鸣笛或闪灯指令。".into());
    }
    let mut client = ChinaClient::new()?;
    client.set_experimental(true);
    client.connect().await?;
    let command = Command {
        vin: vin.to_owned(),
        action: action.to_owned(),
        value,
        ..Default::default()
    };
    client.validate_command(&command)?;
    if !confirmed {
        println!("dry-run：车辆与能力检查通过，未发送。加 --yes 才会执行。");
        return Ok(());
    }
    let prepared = client.prepare(&command).await?;
    let (status, message) = if raw {
        let (bytes, status, message) = client.execute_verbose(prepared).await?;
        println!(
            "原始回执（hex）：{}",
            bytes
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        (status, message)
    } else {
        client.execute(prepared).await?
    };
    println!("回执：{status} · {message}");
    let Some(endpoint) = confirmation::endpoint(action) else {
        println!("该动作没有对应的回读项目。");
        return Ok(());
    };
    for attempt in 1..=5 {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        match client.refresh_reading(vin, endpoint).await {
            Ok(reading) => {
                println!(
                    "回读 {attempt}/5：{} {}",
                    reading.status,
                    serde_json::to_string(&reading.value).unwrap_or_default()
                );
                if reading.status == "success" {
                    return Ok(());
                }
            }
            Err(error) => println!("回读 {attempt}/5 失败：{error}"),
        }
    }
    Ok(())
}

fn usage() -> Result<()> {
    eprintln!(
        "Norr 诊断 CLI\n\
         \n\
         --status        查看本机会话与签名配置状态\n\
         --fleet         连接并列出账号下的车辆与平台\n\
         --probe <VIN>   逐个读取 14 个 endpoint，输出字段、协议与原始响应（hex）\n\
         --set-xchanger  从标准输入读取 xchanger JWT\n\
         --xchanger-exchange  用当前 Polestar 会话换取并保存 xchanger 令牌\n\
         --xchanger-status <VIN>\n\
                         读取 Geely xchanger 聚合状态（含位置）\n\
         --xchanger-climate <start|stop> <VIN> [--yes]\n\
                         通过 xchanger 控制驻车空调\n\
         --ping <VIN>     发送 UpdateStatus（只读调用），检查指令通道\n\
         --snapshot <VIN> 读取一次完整快照\n\
         --command <action> <VIN> [--value N] [--yes]\n\
                         执行单个指令；默认 dry-run，鸣笛/闪灯被拒绝\n\
         --set-key       从标准输入读取 NORR_POLESTAR_CN_SIGNING_KEY 并写入系统凭据存储\n\
         \n\
         探测会两次尝试不同协议，单次最长约 25 秒/endpoint；只读，不发送车辆指令。"
    );
    Err("缺少参数".into())
}
