# 官方外置日语语言包 / Official Japanese locale

日语插件源码位于 `japanese-locale/`，使用 v3 声明式语言包协议。维护记录放在 `japanese-locale-maintenance.json`，不进入安装包。

正式下载来自 [GitHub Releases](https://github.com/Uyoung666/ai-image-manager/releases)：每个新正式版本附带 `com.aiimagemanager.japanese-locale-<软件版本>.aim-plugin`，插件版本和最低宿主版本均与软件一致。仅下载存在正式附件的版本；首次完整发布流程随下一正式版本交付。

安装：设置 → 插件 → 导入 → 核对官方签名、版本和覆盖率 → 确认安装 → 使用此语言，或在语言选择中选择 `日本語 (ja-JP)`。安装不会自动切换语言，使用时无需开启开发者模式。升级使用更高版本安装包；同版本覆盖和降级会被拒绝。

开发与签名发布命令、原文审校规则、升级恢复及问题排查见 [插件开发指南](../docs/plugin-development.md)。本地版本号更新后运行 `npm run locale:sync-version` 与 `npm run locale:check`。CI 使用最后一个正式 GitHub Release 作为基线，适配失败会阻止新版本正式发布。

The official Japanese plugin is an optional external v3 locale package. Download the `.aim-plugin` attachment matching your application version from a formal GitHub Release, import it in Settings → Plugins, verify its official signature and coverage, confirm installation, and select `日本語 (ja-JP)`. Installation does not change the active language automatically. Update with a higher package version; replacing the same version and downgrading are rejected. See the [English plugin guide](../docs/plugin-development.en.md) for development and release details.
