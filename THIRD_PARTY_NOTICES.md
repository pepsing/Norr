# 第三方来源与许可

## 初始工程

Norr 初始界面从 Hisingen 工作区的 React 预览迁入。原工程使用 MIT 许可，版权声明为 Copyright (c) 2026 Nicolas Kheirallah。

[保留的许可全文](LICENSE) · [上游项目](https://github.com/NicolasKheirallah/Hisingen)

## 字体

界面使用 Archivo，通过 `@fontsource/archivo` 安装。其许可为 SIL Open Font License 1.1，随项目保留字体作者声明与许可全文。

[Archivo 许可](licenses/archivo-OFL.txt)

## 图标

界面使用 `lucide-react`。随项目保留 Lucide 的 ISC 许可及其列出的 Feather 衍生图标 MIT 许可。

[Lucide 许可](licenses/lucide.txt)

## 车辆图片

`apps/web/public/images/vehicles` 包含 176 张从 Polestar 官网取得的车型图片。`manifest.json` 保存原始 URL、车型、配置、颜色、尺寸、文件大小和 SHA-256。

图片权利归 Polestar 及相关权利人，公开分发授权待确认。本地预览使用这些图片展示车型外观。旧版备用图片 `apps/web/public/images/polestar-4.webp` 同样来自极星车型素材。

[车型素材来源与范围](apps/web/public/images/vehicles/README.md) · [文件清单](apps/web/public/images/vehicles/manifest.json)

其余 npm 依赖的版本由根目录 `package-lock.json` 固定，许可随安装包提供。

## 地图与坐标转换

车辆位置使用高德官方嵌入页面，地图内保留服务方标识，外部入口使用高德 URI、Google Maps URLs 和 Apple 地图链接。高德嵌入服务按官方服务条款使用。[高德嵌入说明](https://lbs.amap.com/api/uri-api/guide/embedded-map/summarize)

WGS84 与 GCJ-02 的本地转换使用 `coordtransform` 2.1.2，MIT 许可随源码及 macOS 应用包保留。[许可全文](licenses/coordtransform-MIT.txt) · [上游项目](https://github.com/wandergis/coordtransform)
