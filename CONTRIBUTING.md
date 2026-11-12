# 反馈与参与开发

## 提交问题

在 Issues 选择“问题反馈”或“功能建议”。一个 issue 聚焦一个问题，填写版本、平台、步骤和实际结果。安装包来自 Actions 时附上运行链接，便于找到对应提交。[提交 issue](https://github.com/pepsing/Norr/issues/new/choose)

车控和刷新问题请补充发生时间、时区、记录页的服务结果与独立回读结果。已有的官方 App 对照结果也可以附上。截图和日志应遮盖手机号、完整 VIN、车牌和位置，凭据、验证码、会话备份及签名文件保留在本机。

## 将 issue 交给 Codex

维护者确认复现信息与验收条件后，可以在本地 Codex 或已连接仓库的 Codex Cloud 中提供 issue 链接，要求定位原因、修复并创建 PR。可使用以下任务描述。

> 处理 issue 的链接。先阅读 AGENTS.md，核对复现步骤和预期结果，定位根因并完成修复。运行相关检查，记录实际结果和待验证项，创建关联该 issue 的 PR。需要真实账号或实车操作时说明验证步骤。

issue 表单提供统一的反馈字段。当前由维护者发起修复任务，合并前检查代码、CI 和测试证据。GitHub 的 Codex 自动审查需要在 Codex 设置中连接仓库并启用，也可以在已配置的 PR 中评论 `@codex review`。[Codex Cloud](https://learn.chatgpt.com/docs/cloud) · [GitHub 代码审查](https://learn.chatgpt.com/docs/third-party/github)

## 本地与云端分工

本地 Codex 可继续负责钥匙串、手机安装、模拟器、短信与实车调试。Cloud 适合独立的界面修复、逻辑调整、代码阅读和 PR 工作，可以与本地并行使用。

Cloud 环境从仓库根目录执行 `npm ci`，按任务运行 `npm run test --workspace @norr/web` 和 `npm run build`。原生 Rust 宿主目前实现了 macOS、Windows、Android 和 iOS 平台分支，运行原生检查需要对应工具链。GitHub Actions 提供 macOS、Windows 原生测试和四端打包。云端任务中记录可执行的检查，将平台限制与后续 CI 结果一并交接。

## 提交修改

阅读 `AGENTS.md` 和目标目录说明。界面修改按 `DESIGN.md` 验证浅深主题及手机、桌面尺寸。复用现有状态与能力判断，覆盖问题相关的失败和恢复分支。回归用例优先使用固定数据，避免依赖真实车辆状态。

PR 关联 issue，说明根因、改动、已运行的检查与待验证项。服务接受指令、服务完成与车辆回读各自保留证据，测试范围按实际记录。[原生构建与 Actions](apps/native/README.md#github-actions)

## 版本更新说明

每日 alpha 发布会从 PR 标题和直接提交摘要生成更新列表。标题应说明用户可感知的变化，例如“修复空调开启后状态未刷新”。PR 正文用 `Closes #123` 关联已解决的问题，用 `Refs #123` 引用仍需跟进的问题，也可以使用同仓库的完整 issue URL。自动版本说明会附上关联 issue 的标题、链接和状态。

每天北京时间 03:20 检查 main，未发布提交会进入下一版。相同提交再次运行时跳过构建，维护者可在 Actions 的 `Daily alpha release` 中手动提前执行。[alpha 版本下载](https://github.com/pepsing/Norr/releases)
