# 发布与恢复

## 正常发布

1. 保证目标版本已有 `vX.Y.Z` Tag，Tag 中 `package.json` 和 `package-lock.json` 的版本一致，并包含用户可读的 `RELEASE_NOTES_vX.Y.Z.md` 更新说明。
2. 在 GitHub Actions 打开 **Release**，选择包含本流程的 `main`，输入版本号，例如 `2.3.0`。正常发布不要填写 `source_run_id`。
3. 检查通过后自动发布 GitHub Release，最后切换 COS stable。无需搬运附件或重复审批。

只保留这一手动发布入口。旧 Promote、Recover 工作流成为兼容调用入口，不再单独手动触发。推送 Tag 本身不会开始发布，避免一次版本触发两次构建。

发布预检从应用 Tag 对应的精确提交读取更新说明，保存到发布上下文和产物清单，创建或恢复草稿时使用同一份正文。说明缺失、只有标题或代码对比链接时在构建前报错，不再依赖 GitHub 自动生成的空正文。重试不会覆盖已经正式发布后人工编辑的说明。

任务依赖：预检 → 构建并保存 → 安装测试、构建证明 → GitHub 草稿 / COS 下载文件 → COS 桶内复制更新包 → 正式发布与 stable 切换。stable/build-base 复用已核验的下载对象进行桶内复制，不再从运行器重复上传大包。

应用始终从指定 Tag 构建，发布工具使用所选工作流提交。构建任务没有 COS 凭据。安装测试通过临时 `127.0.0.1` 更新源完成 Setup、增量、MSI 升级和数据保留检查，不向 COS 写 testing 或 candidate。正式应用继续使用打包时注入的 HTTPS 地址，不增加运行时更新源覆盖入口。

## 失败后如何继续

- 上传或上线任务失败：在原运行选择 **Re-run failed jobs**。已成功的构建和其他独立任务不重跑。
- 需要使用修复后的发布工具恢复：重新触发 Release，版本保持一致，`source_run_id` 填原运行 ID。只接受完整保存、证明通过且安装测试通过的产物；不会为了补传重新打包。安装测试失败时在原运行重跑失败任务。
- 同名同哈希文件跳过；同名不同内容停止，不能覆盖已经发布的版本。应用内容有变动时使用新版本号。
- GitHub 已上线而最后 COS 切换失败：GitHub 和 COS 不能跨平台原子提交，运行摘要会提示这一情况。重跑失败任务即可补齐 COS，不能把草稿存在或恢复指针成功当成 stable 已上线。
- 构建 Artifact 保存 7 天，清单、Artifact ID、摘要、应用提交、工具提交和测试证据保存 90 天；已上线安装包长期保存在 GitHub Release。恢复需在构建 Artifact 过期前进行。

2.2.0 的历史可恢复源是运行 `36282664740`，应用提交 `6cdc3308c4a15da1b12bbb5fddc11ca31a5a060c`。旧流程的最后交接失败不等于构建或升级测试失败。恢复先验证原始 SHA256 清单、构建证明和三项升级证据，再使用同一套文件。该运行和版本暂时固定受到临时对象清理保护。

## 上传时限与权限

COS 单请求截止 120 秒；连续 120 秒没有进展或上传任务超过 20 分钟时，父进程通知子进程取消请求、销毁上传流并尝试中止分块会话，5 秒清理期后终止进程树。瞬时网络错误最多重试两次；403 等权限错误不重试。日志输出文件、字节数、分块和重试原因。

发布凭据保存在现有 `release-candidate`（版本下载目录）及 `release-stable`（stable/build-base）环境中，环境不应配置人工审批。只允许所需发布前缀的上传、分块初始化/上传/完成/中止。正式目录通过公开 HTTPS 读取核验，兼容原来只能写入的发布身份；不把私有 candidate 目录改为公开。

维护身份另外需要限定前缀的列举、读取、删除权限，以及读取桶版本控制配置。生命周期配置操作需要读取/设置桶生命周期权限，可由管理员单独执行。不要给构建任务这些权限，不要把凭据写入清单或仓库。

## 存储维护

**Maintain COS release storage** 默认手动预览；确认维护权限和手动预览成功后，将仓库变量 `COS_STORAGE_MAINTENANCE_ENABLED` 设置为 `true`，启用每日定时清理。定时运行先保存预览，再重新盘点并清理超过 7 天的临时安装包。维护与发布共用并发锁；检测到其他发布或恢复运行时停止清理。现存未过期构建和恢复 Artifact 引用的版本/运行受到保护。权限未配置时不每日重复运行失败的清理任务。

维护权限缺口排查：`inventory` 的 403 对应 `cos:GetBucket`（桶资源，并通过 URL 编码的 `cos:prefix` 条件限定应用发布目录）；清理还需要 `cos:HeadObject`、`cos:DeleteObject`（仅 testing/runs 和 candidates）及 `cos:GetBucketVersioning`。生命周期配置需要 `cos:GetBucketLifecycle` 和 `cos:PutBucketLifecycle`，由桶管理员授予或单独在控制台配置。参考[官方条件键](https://cloud.tencent.com/document/product/436/71307)和[生命周期权限](https://cloud.tencent.com/document/product/436/8278)。

手动操作：

| 操作 | 行为 |
| --- | --- |
| `inventory` | 盘点 testing、candidate、downloads、stable、build-base 的完整对象 |
| `preview-expired` | 保存可清理对象、大小、ETag 和保护引用，不删除 |
| `prune-expired` | 保存预览并重新验证，然后删除符合条件的临时对象 |
| `configure-multipart-lifecycle` | 保留现有规则，增加发布前缀内未完成分块 1 天后中止规则 |

清理只允许临时前缀中的已知发布文件，始终保护正式下载、stable、build-base、`.csv`、`.xlsx` 和任意层级 `Temp`。预览与执行之间对象变化即停止。桶版本控制为 Enabled 或 Suspended 时拒绝删除，避免只产生删除标记而没有释放旧版本空间；这种桶需先单独盘点对象版本。

生命周期配置不是上传代码后自动生效，需运行上述配置操作并确认成功。完整对象盘点不包含历史版本和未合并分块，不能用它直接估算账单。参见[腾讯云碎片文件说明](https://cloud.tencent.com/document/product/436/17313)。

### 已上线版本的人工核定清理

`Clean reviewed release temporaries` 用于已明确授权的临时副本清理。输入成功的 inventory 运行 ID、成功的正式发布运行 ID、版本及逐个核定的 testing 运行 ID；默认只预览，`apply` 才执行删除。此入口允许在正式发布与可恢复 Artifact 均已确认后提前回收临时副本，不受自动清理的 7 天和恢复源固定保护限制，且不删除 GitHub Artifact。

清理前确认无发布或恢复正在运行、每个目标运行已结束、GitHub 正式包与 stable 元数据一致、发布 bundle 和测试证据 Artifact 未过期，并拒绝启用或暂停版本控制的桶。只清理原 inventory 中大小、ETag、修改时间均未变化的指定 testing 目录及该版本 candidate 文件；保护正式目录和用户文件。先保存预览，再逐项记录删除结果，最后复核正式目录未变和目标对象已不存在。同时盘点未完成分块，仅中止核定临时目录内超过一天且预览后未变化的会话。此入口不修改生命周期规则。

## 开发验证

```powershell
npm test -- src/tests/unit/release-pipeline.test.mjs src/tests/unit/release-cos.test.mjs src/tests/unit/release-cos-maintenance.test.mjs src/tests/unit/windows-installer-smoke.test.mjs
npm test
npm run check
```

另用 actionlint 验证四个发布/维护 YAML。故障测试覆盖 403、断网、SDK 不回调、进程终止、重复补传、哈希冲突、stable 最后写入和清理保护。真实 Setup/MSI 安装应在 GitHub Windows 临时运行器执行，避免改动开发者正在使用的安装。
