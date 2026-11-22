# Polestar 4 兼容性

## iPhone 实测 Build 5

Norr 通过中国区账号车库识别 HUANFU 车辆，沿用车主会话读取 C3。开始记录、手动读取和完成记录都会采集当前车辆的电量、门锁、驻车空调、车内温度、总里程、四轮胎压、软件服务版本和充电上限参考值。胎压按 kPa 四舍五入显示。导出的 JSON 保留每项读取状态、采集时刻以及服务提供的上报时刻，使用本轮车辆代号关联多车记录。

qicents 在 2023 款 P4 上读到的电量是 49%。同一次调查中，C3 返回的充电上限为 90%，官方 App 显示 100%。Build 5 把这个字段单列为「充电上限（C3 参考值）」。确认设置是否生效仍需车机或官方 App 核对。软件服务返回的版本也单独标注。Build 5 的实车写入尚未接入。[qicents 的实车记录](https://github.com/pepsing/Norr/blob/60af4a1c44200c71138e3004cc1cbce2507dc56b/docs/analysis/2026-11-21-c3companion-p4.md)
