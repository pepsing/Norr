fn main() {
    #[cfg(target_os = "macos")]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        let api =
            std::env::var_os("DEP_TAURI_IOS_LIBRARY_PATH").expect("Tauri iOS API path is required");
        let directory = std::path::Path::new("ios/.tauri");
        std::fs::create_dir_all(directory).expect("create Tauri package directory");
        let link = directory.join("tauri-api");
        if std::fs::read_link(&link).ok().as_deref() != Some(std::path::Path::new(&api)) {
            if link.symlink_metadata().is_ok() {
                std::fs::remove_file(&link).expect("replace Tauri package link");
            }
            std::os::unix::fs::symlink(api, link).expect("link Tauri iOS API");
        }
        tauri_utils::build::link_apple_library("NorrMobile", "ios");
        println!("cargo:rerun-if-changed=ios/Sources");
        println!("cargo:rerun-if-changed=ios/Package.swift");
        println!("cargo:rustc-link-lib=framework=LocalAuthentication");
        println!("cargo:rustc-link-lib=framework=UniformTypeIdentifiers");
        println!("cargo:rustc-link-lib=framework=UserNotifications");
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("src/macos.m")
            .file("src/verification.m")
            .flag("-fobjc-arc")
            .compile("norr_macos");
        println!("cargo:rustc-link-lib=framework=LocalAuthentication");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=UserNotifications");
        println!("cargo:rustc-link-lib=framework=ServiceManagement");
        println!("cargo:rustc-link-lib=framework=WebKit");
        println!("cargo:rerun-if-changed=src/macos.m");
        println!("cargo:rerun-if-changed=src/verification.m");
    }
    tauri_build::build()
}
