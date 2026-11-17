# Norr Watch 设计交付

本目录包含 2026-11-17 确认的首版需求和 HTML 设计稿（版本 04，首页活动按钮橙色，含解锁与锁车；空调使用默认舒适温度 22 °C），不包含原生 watchOS 功能。

- [单文件 HTML](norr-watch-design.html)：交付文件，车图、图标、字体、CSS 和交互脚本全部内嵌，无运行时外部依赖。
- [需求与验收条件](requirements.md)：联网、会话同步、门锁与空调状态机、范围和实施顺序。
- [设计验证记录](design-qa.md)：视觉继承、尺寸、点击记录和未验证边界。
- [主要画面预览](preview-overview.jpg)、[门锁画板](preview-locks.jpg)、[状态画板](preview-states.jpg)、[完整画板](preview-full.jpg)、[窄屏门锁](preview-mobile.jpg)、[窄屏空调](preview-climate-mobile.jpg)、[窄屏活动首页](preview-home-active-mobile.jpg)。

HTML 可保存到本机用浏览器打开。内置预览浏览器只允许 HTTP/HTTPS，本轮在本机 HTTP 下完成操作验证，没有用该浏览器执行 file:// 打开。

## 修改与重新打包

`index.html`、`design.css`、`design.js` 是可编辑源文件。只改本目录即可迭代设计，不修改应用代码。

从仓库根目录运行：

```sh
node docs/design/watch/build.mjs
```

仅在需要重新提取原项目素材时运行：

```sh
node docs/design/watch/prepare-assets.mjs
node docs/design/watch/build.mjs
```

打包脚本将已有资源内嵌到 HTML，不改变 UI 结构。素材原路径、版本和 SHA-256 记录在 [manifest](assets/manifest.json)。车辆图片没有重绘或再生成。字体与图标的许可一并保留。

## 本机预览

启动前检查端口：

```sh
lsof -nP -iTCP:4387 -sTCP:LISTEN
python3 -m http.server 4387 --bind 127.0.0.1 --directory docs/design/watch
```

在浏览器打开 `http://127.0.0.1:4387/norr-watch-design.html`。所有按钮只更新演示状态，不会登录账号或发送车控。
