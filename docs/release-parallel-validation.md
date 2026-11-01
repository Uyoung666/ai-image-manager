# 发布并行验证

发布工作流只构建一次，四个独立 Windows runner 各以一个 worker 执行 E2E；四组和单元测试全部成功后才封装 bundle。仅验证模式的 bundle 禁止发布和恢复；正常发布模式的 bundle 保持原恢复能力。安装包、日语插件及真实更新下载校验仍在 package 任务中执行。

## 在 GitHub 上验证

1. 经授权提交、推送流程改动后，在包含新工作流的 `main` 分支上手动运行 Release，应用版本填写 `2.2.6`。`release-stable` 环境仅允许 `main` 使用日语签名密钥，验证沿用该限制。应用源码使用已有 `v2.2.6` Tag，无需修改版本号、创建新 Tag 或发布新版本。
2. 设置 `validate_only=true`，不填写 `source_run_id`。该模式允许重建已发布版本并自动生成内部验证说明，仍执行安装冒烟、日语签名校验和产物证明；不会执行 GitHub 发布任务。正常发布模式仍拒绝重建已发布版本。
3. 在相同 Tag 上连续验证两次。比较整个运行的起止时间，以及 package、各组依赖准备、测试、下载、build 封装、smoke 的耗时。先前完整发布约 48 分 44 秒；30～36 分钟仅为目标，不能作为已测收益。
4. 使用同一提交串行运行 `npm run test:e2e -- --no-build --workers=1`，与四组报告比较通过、跳过、重试情况，重点检查响应式窗口尺寸、窗口焦点和清理行为。正式使用前应完成该 CI 对照。

四组共享同一 `.vite` 构建身份，安装包中间产物单独传递。检查 build 摘要中的用例总数与每组耗时，并保存 Actions 运行链接。当前代码共有 217 项 E2E；数量随源码变化，门禁以本次构建收集的完整清单为准，不硬编码总数。

## 故障与报告

- 测试失败时使用 Actions 的“重新运行失败的作业”，复用成功 package 的产物 ID。报告名称包含运行 ID、分组和尝试号；汇总会选取匹配本次构建身份的每组最新报告。
- `release-shard-*` 含 JSON 结果、Blob 报告和构建身份；`release-e2e-diagnostics-*` 含测试诊断。报告保留 30 天，中间产物保留 7 天。
- 下载各组的 Blob ZIP 到同一目录后，可通过 `npx playwright merge-reports --reporter html <目录>` 合并查看。不同 runner 的文件路径会由 Playwright 报告合并处理。
- 新增跳过测试会阻止正式封装。已有八个需要外部输入的条件跳过由 `scripts/release/parallel.mjs` 中的精确测试名称清单限定；新增例外必须说明缺少的外部前提并审查。
- 验证模式使用 `validation-bundle-*`、`validation-artifact-*` 和 `validation-smoke-*`，与正式产物分开。bundle 的 `validateOnly` 标记、来源运行标记和发布函数校验共同阻止验证产物通过恢复流程上线。
- `source_run_id` 只接受现有校验认可的正式 bundle，不能用验证产物、`release-input-*` 或 `release-vite-*` 恢复发布。旧流程产出的合格 bundle 继续使用原恢复逻辑。

Squirrel 任务启用了 `electron-windows-installer:*` 日志，可通过带时间戳的 NuGet、SyncReleases 与 releasify 子进程日志分析打包耗时。当前没有更改差分算法、压缩设置或安装包格式。
