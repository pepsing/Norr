#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

#[cfg(all(target_os = "macos", feature = "p4-demo"))]
fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("Polestar 4 演示窗口启动失败");
}

#[cfg(not(all(target_os = "macos", feature = "p4-demo")))]
fn main() {
    norr_lib::run();
}
