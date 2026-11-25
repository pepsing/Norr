use crate::Result;
use reqwest::Client;
use semver::Version;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{io::Write, path::Path, time::Duration};
use tauri::{AppHandle, Manager};

const API: &str = "https://api.github.com/repos/pepsing/Norr/releases";
const DOWNLOAD: &str = "https://github.com/pepsing/Norr/releases/download";
static INSTALL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    size: u64,
    digest: Option<String>,
}

fn suffix() -> Result<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("macos-arm64.zip"),
        ("windows", "x86_64") => Ok("windows-x64-setup.exe"),
        ("android", "aarch64") => Ok("android-arm64.apk"),
        _ => Err("GitHub Release 暂无适用于此架构的安装包".into()),
    }
}

fn candidate<'a>(
    release: &'a Release,
    installed: &Version,
    suffix: &str,
) -> Option<(Version, String, &'a Asset)> {
    let tag = release.tag_name.strip_prefix('v')?;
    let version = Version::parse(tag).ok()?;
    if release.draft || version.cmp_precedence(installed).is_le() {
        return None;
    }
    let name = format!("Norr_{tag}_{suffix}");
    let asset = release.assets.iter().find(|asset| asset.name == name)?;
    Some((version, name, asset))
}

fn client() -> Result<Client> {
    Client::builder()
        .https_only(true)
        .user_agent("Norr-update")
        .connect_timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| e.to_string())
}

async fn metadata<T: serde::de::DeserializeOwned>(client: &Client, url: String) -> Result<T> {
    client
        .get(url)
        .timeout(Duration::from_secs(25))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("无法检查 GitHub Release：{e}"))?
        .json()
        .await
        .map_err(|e| format!("无法读取 GitHub Release：{e}"))
}

async fn installed(app: &AppHandle) -> Result<Version> {
    Version::parse(&crate::app_version(app.clone()).await?)
        .map_err(|_| "无法识别当前安装版本".into())
}

#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<String>> {
    let platform = suffix()?;
    let current = installed(&app).await?;
    let client = client()?;
    let mut best = None;
    for page in 1.. {
        let releases: Vec<Release> =
            metadata(&client, format!("{API}?per_page=100&page={page}")).await?;
        for release in &releases {
            if let Some((version, _, _)) = candidate(release, &current, platform) {
                if best
                    .as_ref()
                    .is_none_or(|old| version.cmp_precedence(old).is_gt())
                {
                    best = Some(version);
                }
            }
        }
        if releases.len() < 100 {
            break;
        }
    }
    Ok(best.map(|version| version.to_string()))
}

#[tauri::command]
pub async fn install_update(app: AppHandle, version: String) -> Result<()> {
    let _guard = INSTALL.try_lock().map_err(|_| "更新已在进行")?;
    let requested = Version::parse(&version).map_err(|_| "无效的版本号")?;
    let client = client()?;
    let release: Release = metadata(&client, format!("{API}/tags/v{requested}")).await?;
    let (found, name, asset) =
        candidate(&release, &installed(&app).await?, suffix()?).ok_or("此版本没有可安装的更新")?;
    if found != requested {
        return Err("发布版本不匹配".into());
    }
    #[cfg(target_os = "android")]
    crate::mobile::call_async::<()>("prepareUpdate", serde_json::json!({})).await?;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("updates");
    let path = download(&client, &found, &name, asset, &cache).await?;
    install(&app, &path).await
}

async fn download(
    client: &Client,
    found: &Version,
    name: &str,
    asset: &Asset,
    cache: &Path,
) -> Result<std::path::PathBuf> {
    let digest = asset
        .digest
        .as_deref()
        .and_then(|v| v.strip_prefix("sha256:"))
        .filter(|s| s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or("安装包缺少 SHA-256 校验信息")?;
    if asset.size == 0 || asset.size > 1024 * 1024 * 1024 {
        return Err("安装包大小异常".into());
    }
    std::fs::create_dir_all(cache).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(cache).map_err(|e| e.to_string())?;
    let mut response = client
        .get(format!("{DOWNLOAD}/v{found}/{name}"))
        .timeout(Duration::from_secs(600))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("下载失败：{e}"))?;
    let mut hash = Sha256::new();
    let mut size = 0;
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        size += chunk.len() as u64;
        if size > asset.size {
            return Err("安装包大小不匹配".into());
        }
        hash.update(&chunk);
        file.write_all(&chunk).map_err(|e| e.to_string())?;
    }
    if size != asset.size || !format!("{:x}", hash.finalize()).eq_ignore_ascii_case(digest) {
        return Err("安装包校验失败，请重新下载".into());
    }
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    let path = cache.join(name);
    file.persist(&path).map_err(|e| e.to_string())?;
    Ok(path)
}

#[cfg(target_os = "android")]
async fn install(_: &AppHandle, path: &Path) -> Result<()> {
    crate::mobile::call_async("installUpdate", serde_json::json!({"path":path})).await
}

#[cfg(target_os = "windows")]
async fn install(app: &AppHandle, path: &Path) -> Result<()> {
    std::process::Command::new(path)
        .arg("/UPDATE")
        .spawn()
        .map_err(|e| format!("无法启动安装程序：{e}"))?;
    app.exit(0);
    Ok(())
}

#[cfg(target_os = "macos")]
async fn install(app: &AppHandle, path: &Path) -> Result<()> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let bundle = exe
        .ancestors()
        .nth(3)
        .filter(|p| {
            p.extension().is_some_and(|ext| ext == "app")
                && exe.starts_with(p.join("Contents/MacOS"))
        })
        .ok_or("请先从已安装的 Norr.app 启动更新")?;
    replace_mac_bundle(bundle, path, || {
        std::process::Command::new("/bin/sh")
            .args([
                "-c",
                r#"while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; exec /usr/bin/open "$2""#,
                "norr-update",
            ])
            .arg(std::process::id().to_string())
            .arg(bundle)
            .spawn()
            .map(|_| ())
    })?;
    app.exit(0);
    Ok(())
}

#[cfg(target_os = "macos")]
fn replace_mac_bundle(
    bundle: &Path,
    path: &Path,
    relaunch: impl FnOnce() -> std::io::Result<()>,
) -> Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt, process::Command};
    let staging = tempfile::Builder::new()
        .prefix(".norr-update-")
        .tempdir_in(bundle.parent().ok_or("无法定位安装目录")?)
        .map_err(|e| {
            format!("无法写入安装目录，请将 Norr.app 移到可写的应用程序目录后重试：{e}")
        })?;
    let replacement = staging.path().join("Norr.app");
    let run = |cmd: &mut Command| -> Result<()> {
        let out = cmd.output().map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!(
                "安装准备失败：{}",
                String::from_utf8_lossy(&out.stderr)
            ))
        }
    };
    run(Command::new("/usr/bin/ditto")
        .args(["-x", "-k"])
        .arg(path)
        .arg(staging.path()))?;
    run(Command::new("/usr/bin/codesign")
        .args([
            "--verify",
            "--deep",
            "--strict",
            "-R=identifier \"app.norr.mac\"",
        ])
        .arg(&replacement))?;
    let target = CString::new(bundle.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    let source = CString::new(replacement.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    // Both bundles are on the same volume. A failed swap leaves the running copy intact.
    let swap = || unsafe { libc::renamex_np(source.as_ptr(), target.as_ptr(), libc::RENAME_SWAP) };
    if swap() != 0 {
        return Err(format!("无法替换应用：{}", std::io::Error::last_os_error()));
    }
    if let Err(e) = relaunch() {
        if swap() != 0 {
            return Err("新版本已安装，请手动重新打开 Norr".into());
        }
        return Err(format!("无法重新启动应用：{e}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selects_only_newer_matching_assets() {
        let mut release: Release = serde_json::from_value(serde_json::json!({
            "tag_name":"v0.2.1-alpha.10","draft":false,
            "assets":[{"name":"Norr_0.2.1-alpha.10_android-arm64.apk","size":100}]
        }))
        .unwrap();
        let alpha = Version::parse("0.2.1-alpha.9").unwrap();
        assert!(candidate(&release, &alpha, "android-arm64.apk").is_some());
        assert!(candidate(&release, &alpha, "windows-x64-setup.exe").is_none());
        assert!(candidate(&release, &Version::new(0, 2, 1), "android-arm64.apk").is_none());
        release.draft = true;
        assert!(candidate(&release, &alpha, "android-arm64.apk").is_none());
    }
}

#[cfg(all(test, target_os = "macos"))]
#[test]
#[ignore = "downloads the specified public GitHub release into a temporary directory"]
fn verify_release_install_in_isolation() {
    let tag = std::env::var("NORR_TEST_RELEASE_TAG").unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = tauri::async_runtime::block_on(async {
        let client = client().unwrap();
        let release: Release = metadata(&client, format!("{API}/tags/{tag}"))
            .await
            .unwrap();
        let (version, name, asset) =
            candidate(&release, &Version::new(0, 0, 0), suffix().unwrap()).unwrap();
        download(&client, &version, &name, asset, dir.path())
            .await
            .unwrap()
    });
    let bundle = dir.path().join("Norr.app");
    std::fs::create_dir(&bundle).unwrap();
    let marker = bundle.join("original");
    std::fs::write(&marker, b"original").unwrap();
    assert!(
        replace_mac_bundle(&bundle, &path, || Err(std::io::Error::other(
            "simulated launch failure"
        )))
        .is_err()
    );
    assert!(marker.is_file());
    replace_mac_bundle(&bundle, &path, || Ok(())).unwrap();
    assert!(bundle.join("Contents/Info.plist").is_file());
    assert!(!marker.exists());
}
