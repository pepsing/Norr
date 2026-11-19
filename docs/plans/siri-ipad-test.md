# 北行 iPad Siri 测试指南

适用测试包为 0.1.0 build 1017，目标设备为 iPad mini（A17 Pro）。本轮只测车辆电量、续航和门锁状态。

1. 用原来的 AltStore 账号安装。在 iPad 的「文件」中解压 `Norr-Siri-iPad-1017.zip`，打开 AltStore 的 My Apps，点加号选择解出的 IPA。若提示处理扩展，选择 Keep App Extensions。安装时让 iPad 保持 USB 连接，Mac 上的 AltServer 保持运行。设备上仍有旧版北行时，优先覆盖安装以沿用应用数据。[AltServer 官方连接说明](https://faq.altstore.io/altstore-classic/altserver)
2. 打开北行，确认能看到 Polestar 的车辆概览。记下电量、续航、门锁状态及车辆上报时间，供后面比对。若应用要求重新登录，在北行内完成登录。
3. 在「快捷指令 → App → 北行」分别点「车辆电量」和「门锁状态」。预期前者显示电量百分比和续航公里数，后者显示已锁、未锁或未知。两项结果应附车辆上报时间，并和北行概览一致。
4. 点北行快捷指令页右上角的 ⓘ。如果 Siri 开关关闭，打开它。确认 iPad 的 Siri 语言为普通话。唤醒 Siri，或长按 iPad mini 的顶部按钮，分别说下面两句。[Apple 的 iPad Siri 设置](https://support.apple.com/zh-cn/guide/ipad/ipade5045bb1abc/27/ipados/27)

   - 「用北行查看车辆电量」
   - 「用北行查看门锁状态」

5. 两句都通过后，从应用切换器退出北行，再说一遍「用北行查看车辆电量」。预期 Siri 能显示或读出结果。在普通前台查询、退出应用后查询这两种情形分别记录结果。

如果快捷指令能查到数据，但 Siri 打开了搜索或识别成其他词，记录 Siri 显示的转写和回复。如果快捷指令本身失败，记录动作名称及完整提示。车辆时间以返回的上报时间为准，时间较早时仍应原样显示。

回报测试结果时，发一下设备系统版本、两条口令的结果，以及退出北行后能否返回读数即可。

## 2026-11-18 真机结果

用户确认 iPad mini（A17 Pro）的只读测试通过。Mac 通过设备查询确认已安装 0.1.0（1017）。

## AltStore 重签崩溃调查

build 1016 在 AltStore Classic 2.3.3（75）中连续三次崩溃。日志均指向 `AltStoreCore` 的 `ldid::Sign → Allocate`。签名器准备架构进度名称时，字符串构造函数将空指针传给 `strlen`。Mac 上 AltServer 1.8.4 的二进制 UUID 与上游报告一致，对照该报告的调用位置也落在同一段进度名称处理逻辑。[AltServer 崩溃报告](https://github.com/altstoreio/AltStore/issues/1868)

用 Xcode 的 `lipo` 检查 IPA，北行主程序和 iPad 小组件都是 `arm64`，Watch 主程序和 Watch 小组件则同时含有 `arm64` 和 `arm64_32`。AltStore 使用的 ldid 分支在 `Allocate` 中把架构名称初始化为空，识别列表包含 `arm64`，缺少 `arm64_32`，随后直接用该值构造进度名称。这与稳定复现的空指针调用栈吻合。日志没有记录当时正在处理 Watch 主程序还是 Watch 小组件。[ldid 源码](https://github.com/rileytestut/ldid/blob/master/ldid.cpp)

build 1017 移除了嵌套 Watch 包。两份 IPA 的 iPad 主程序和小组件在代码签名数据之前的二进制内容完全相同，App Intents 元数据也相同。1017 已通过同一台 iPad 上的重签安装与只读测试。

AltStore Classic 还存在独立的 Watch 重签缺口，包括嵌套 bundle 的描述文件、权限和配套 App 标识处理。上游已有未合并的改动，本次核对的 ldid 改动未加入 `arm64_32` 的名称处理。个人签名的 iPad 测试继续使用已验证的无 Watch 包。完整包的 Watch 重签需要单独验证这些环节。[Classic Watch 重签改动](https://github.com/altstoreio/AltStore/pull/1859) · [ldid 配套改动](https://github.com/rileytestut/ldid/pull/7)
