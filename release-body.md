# AI Image Manager v2.1.0

## 本次更新

- Windows 应用内更新迁移到香港腾讯云 COS 稳定通道，启动 10 秒后检查，此后每 6 小时检查一次。
- Squirrel `Setup.exe` 与默认安装的 `.msi` 都支持同一套应用内更新：有可靠基线且增量包更小时使用增量包，否则自动回退完整包。
- `.msi` 继续作为可选安装目录的独立安装方式；v2.1.0 建立首个正式 MSI 基线，后续版本会同时验证 Setup 与 MSI 的真实自动升级、数据保留和卸载。
- 新增版本、Tag、package-lock 一致性门禁，以及 testing → candidate → stable 两阶段发布和人工批准。
- GitHub Release 与 COS 工件使用同一份 `SHA256SUMS.txt` 和 `provenance.json`，便于用户及发布流程核验。
- 修复多次检查更新造成的并发下载，并在更新包下载完成后保持首启安装锁。

## 安装包

- `Setup.exe`：推荐给大多数用户，支持应用内自动更新。
- `.msi`：适合需要选择安装目录的用户；默认安装自动更新组件，也支持应用内自动更新。
- `.zip`：便携版，不参与应用内自动更新。

请不要在同一台电脑上同时安装 Setup 与 MSI 版本。

## 安全说明

本项目当前没有 Windows Authenticode 代码签名证书，因此 Windows 可能显示“未知发布者”或 SmartScreen 警告。请只从本项目官方 GitHub Release 下载，并使用随 Release 提供的 `SHA256SUMS.txt` 核对文件哈希。`provenance.json` 会明确记录 `authenticode: not-signed`；它用于可追溯性，不等同于代码签名。

## 更新兼容性

v2.1.0 是从原 GitHub 更新源切换到 COS 的桥接版本，也是首个正式提供的 MSI。现有 Setup 用户仍可通过旧的 GitHub 更新源收到 v2.1.0；升级到本版后，Setup 与默认 MSI 安装都从 COS 稳定通道获取后续版本。若旧版自动更新未成功，可从官方 Release 手动安装 v2.1.0。用户图库、数据库和设置应在升级测试中保持不变。
