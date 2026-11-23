# Android 小组件深色车图同步

2026-11-23，Android 大号桌面小组件同步 iOS / macOS 的透明车图。第一轮按用户要求只修改源码；用户随后授权 USB 安装测试，已在 vivo V2408A（Android 16 / API 36）完成覆盖安装和主题切换验证。

## 图片与外观

复用 `apps/web/public/images/vehicles/` 已有的 80 套 P2 / P4 侧视图及对应抠图。原始来源、授权记录和逐图摘要仍以该目录的 `manifest.json` 为准；没有新增或修改车辆图片。本目录 [manifest.json](manifest.json) 记录 Android 资源改动、来源及摘要。

Rust 同步浅色 JPG 和同配置的 `-side-cutout.webp`；Android 对两者使用相同裁切和 720 像素缓存宽度，深色缓存保存为 PNG，保留透明通道。两张图完成原子写入后再一起发布图片名与车辆快照。旧记录没有深色图或文件不可读时，回退到该记录的浅色图；切换车辆不会沿用上一辆车的深色图。

大号组件的图片区域尺寸和车身位置保持原布局，深色底使用 iOS 对应的 `#20231F`。小号、中号不展示车图。固定外观明确选择对应图片；跟随系统使用昼夜资源控制两张图的显示，由桌面宿主解析主题，不依赖主应用在生成快照时的主题。[Android 昼夜资源说明](https://developer.android.com/develop/ui/views/theming/darktheme#themes_and_styles)

固定外观的大号使用独立布局标识并复用同一内容布局。返回跟随系统时，桌面会重新加载布局，避免 RemoteViews 复用固定模式的图片可见性。

## 本轮检查

- XML 解析、昼夜资源配对、80 套图片及原始 manifest 摘要核对通过。
- `npm run check:native` 的 64 项测试通过；Android release 构建、APK 签名校验、16 KB 对齐检查和 `git diff --check` 通过。没有触发 GitHub 构建或发布。
- 5 项仪器测试在真机 debug 变体通过：同一 RemoteViews 随宿主浅→深→浅选择图片、固定外观不随宿主改变、透明像素与车身像素保留、旧记录和缺失深色文件回退，以及已有的五种尺寸布局和缺失读数显示。
- 尝试对压缩后的 release 运行仪器测试时，测试运行器因 `androidx.tracing.Trace` 被裁剪而退出；该结果不计为通过。改用同源码的 debug 变体完成仪器测试后，已覆盖回 release 包并删除测试辅助包。release 包另行完成以下桌面检查。
- 真机原有大号组件使用固定深色：升级后车图显示透明抠图，浅色棚拍底消失。改为跟随系统后，浅→深→浅均显示对应车图和文字背景；再切回固定深色正常。系统恢复浅色，大号恢复固定深色，中号保持跟随系统，原桌面位置与尺寸未改动。
- 覆盖升级保留登录及小组件配置，首次打开后车辆读取成功并同步到桌面。实际深色缓存为 720 × 225 的 PNG，含透明通道。测试未发送车控命令。
- 本轮没有在桌面拖动缩放组件；五种尺寸的排版由仪器测试覆盖。其他 Android 厂商桌面未实测。

安装包：`target/packages/Norr_0.1.0-dev.1007_android-arm64.apk`，版本号 `1007`。构建程序读取本地 `.env.secrets`，以布尔结果核对原生库中的中国区签名配置，不输出密钥。沿用手机既有签名进行覆盖升级，最终安装包未启用 debuggable。

APK SHA-256：`7f6539141175b579c4a4692b2fd8dafc073e8f0ca89b07577c2a6b7a2c53d022`。从手机回读的已安装 APK 与交付文件摘要一致。构建日志、仪器测试结果和桌面截图仅保存在本机 `target/android-widget-validation-20261123/`，未纳入版本库。

## 交付检查

| 项目 | 结果 | 依据 |
| --- | --- | --- |
| Hard Gate | PASS | 复用已有素材；缺失深色图回退测试通过；覆盖升级保留数据，验证结果区分 release 桌面检查与 debug 仪器测试 |
| Purpose Gate | PASS | 真机深色抠图去掉浅色棚拍底，跟随系统与固定深色均正确选择图片 |
| Liveliness | PASS | 保持 DESIGN.md 的 ENERGY 2 / RHYTHM 2 / MOTION 1、车身配置、字号及排版，真机显示与 iOS 深灰车图底一致 |
| Craftsmanship | PASS（上述设备与范围） | 64 项原生测试、5 项真机仪器测试、release 构建安装和桌面主题往返通过；其他桌面与拖动缩放的边界单独记录 |
