# 发布与自动更新

## 分发边界

GitHub Release 是长期正式分发源。每个正式 Windows Release 必须在同一个草稿中保存
Setup、MSI、ZIP、Squirrel full/delta 包、兼容 `RELEASES`、`update-manifest.json`、
`SHA256SUMS.txt`、`provenance.json` 及作者编写的更新说明。客户端只发现 GitHub API
返回的非 draft、非 prerelease、SemVer 标签 Release；选中版本后只使用该 tag 的固定
`/releases/download/vX.Y.Z/<asset>` 地址，不再跟随 `latest`。

`RELEASES` 仍是 Squirrel.Windows 的三列格式（SHA1、包名或绝对 HTTPS 包地址、字节数）。
GitHub 兼容清单只放当前 full 包，保证仍使用 `update.electronjs.org` 的 2.0.0 客户端
能够完成一次升级；新客户端读取 `update-manifest.json`，其中固定目标版本、full/delta
起止版本（delta 明确记录 `fromVersion`/`toVersion`）、大小和 SHA1/SHA256。没有相邻基线、链路断裂、包校验失败或 delta 应用失败时，
只尝试一次 full 包兜底。

Setup 和启用自动更新的 MSI 具有应用内自动更新能力。禁用更新器的 MSI 与 ZIP 保持手动
升级边界，不能把 ZIP 宣称为自动更新安装。Squirrel 使用现有安装目录和 `Update.exe`，
应用数据目录、数据库、缩略图、向量索引和模型不会因升级而迁移或删除。

更新网络由 Electron 网络栈发起，继承 Windows 系统代理；浏览器扩展代理不会自动传给
更新器。客户端需要能够访问 `api.github.com`、`github.com` 以及 GitHub 附件重定向使用的
下载域名（通常为 `objects.githubusercontent.com`）。代理失效、断网、TLS、超时和限流
都会结束本次任务并显示本地化错误，设置页提供有限重试和固定版本的 GitHub 手动下载入口。

## 正常发布（2.2.1 起）

1. 确认目标 `vX.Y.Z` tag 的 `package.json` 和 lockfile 版本一致，并在应用提交中提供
   `RELEASE_NOTES_vX.Y.Z.md`。在 GitHub Actions 的 **Release** 工作流输入不带 `v` 的
   版本号；正常发布不要填写 `source_run_id`。
2. 预检调用 GitHub API 选择已验证的上一个基线。2.2.1 的一次性基线是 GitHub 上已有的
   v2.2.0 附件（即使该版本仍是 prerelease）；后续版本只接受上一个正式 GitHub Release。
   预检保存 Release ID、tag、清单和包哈希，构建期间不再重新解析 Latest。
3. 构建任务只打包一次并保存 bundle。构建环境通过 GitHub 下载基线，在本地生成相邻 delta，
   执行 Setup、MSI、Squirrel delta/full 和数据保留 smoke；不会访问 COS 的 downloads、
   candidate、testing 或 build-base。
4. 草稿阶段以同一 bundle 上传所有附件。上传按文件名和 SHA256 幂等：同名同内容跳过，
   同名不同内容拒绝覆盖。附件回读后检查包内版本、x64 架构、更新配置、MSI 更新器、
   delta 基线、清单和校验文件；匿名下载和 HTTPS 重定向在公开后再验证。
5. 只有草稿附件和证据全部通过门禁后，工作流才公开 Release。发布证据单独保存 90 天，
   构建 bundle Artifact 保存 7 天。Release 公开后不再上传或切换 COS stable。

发布说明必须来自应用提交，不使用自动生成的比较链接填充空正文。Release 的正文和附件
都由同一份 bundle 驱动，避免检查清单后 `latest` 改变造成清单与包不一致。

## 失败、重试与恢复

- 构建或安装测试失败只重跑对应任务；上传失败只重跑 GitHub 上传/校验任务，不能重新打包。
- 继续同一版本时使用原运行的 `source_run_id`。恢复必须核对 Artifact ID、Artifact digest、
  SHA256、应用提交、发布工具提交和 smoke 证据；Artifact 过期时不得猜测或重建旧版本。
- GitHub Release 已有同名附件时，同内容任务安全跳过；内容不同直接失败并要求新版本号。
- 网络下载具有独立期限：元数据 30 秒；包下载连续 120 秒无进展或累计 30 分钟终止；安装
  阶段的 `Update.exe` 单独限制为 15 分钟。旧任务和其进程结束前不允许重试，过期回调会被忽略。
- 2.2.0 的历史恢复源为运行 `36282664740`，应用提交为
  `6cdc3308c4a15da1b12bbb5fddc11ca31a5a060c`。恢复时要把应用提交与发布工具提交分开核对；
  该信息只用于恢复旧 bundle，不改变 2.2.0 的 prerelease 状态。

## COS 过渡与退出

已发布的旧客户端仍可能把更新请求发往 COS stable，迁移完成前不能关闭旧地址。2.2.1
正式上线后迁移期为 30 天，起算时间以公开 Release 的时间为准。一次性切换由 GitHub Actions
的 `Transition COS stable feed to GitHub` 手动工作流执行；它要求输入版本 `2.2.1` 和精确确认词
`SWITCH COS STABLE TO GITHUB V2.2.1`，并在 `release-stable` 环境执行，避免误写其他版本或其他仓库。

迁移前先对 COS 做完整只读盘点，逐对象记录 key、大小、ETag、修改时间、原清单引用和
GitHub 替代附件哈希。优先在隔离 Windows 环境用未修改的旧 2.1.0/2.2.0 二进制实测
`stable/RELEASES` 仅保留、并把包地址改为 GitHub 固定 HTTPS 附件；Squirrel 源码虽支持
绝对地址，旧二进制不兼容时必须保留安装矩阵证明必需的最小 full/delta 集合。不得凭清单
解析成功推断旧客户端已经迁移。

旧二进制矩阵通过后，工作流先逐个核对当前 COS 清单引用的 GitHub Release 包，以及目标版本
的 delta/full 包：检查 Release 状态、附件大小、GitHub SHA256、Squirrel SHA1；缺少可验证
清单项的 delta 会读取实际附件计算摘要。全部证据通过后，只把 COS
`updates/win32/x64/stable/RELEASES` 的地址改为固定 GitHub URL，包对象不上传、不删除，
GitHub Release 也不修改。相同内容重跑会跳过写入，清单或包内容不一致会拒绝切换。切换成功
后，2.2.0 及更早旧客户端仍从原 COS 地址读取这份清单并下载 GitHub 包；升级到 2.2.1 后，
后续检查直接使用 GitHub API 和固定 Release 附件，不再依赖 COS。

切换后的最小宽限为 48 小时：原清单引用的对象在宽限内保持可读，并再次核对 GitHub 附件、
哈希和引用关系。迁移验证通过、GitHub 匿名下载可用、停服公告和手动升级说明准备齐全后，
再提交 COS 退出申请；申请中列出精确删除 key、大小、ETag 和替代证据。没有遥测依据时不
宣称所有用户已迁移。到期关闭也不自动执行。

退出申请通过后才可撤除 COS 发布任务、专用凭据和维护配置，并删除不再被任何已发布清单
引用的 downloads、build-base、testing、candidate 副本。仍被旧清单引用的包必须继续保留；
`.csv`、`.xlsx` 和任何 `Temp` 内容始终不得删除。

## 验证命令与证据

```powershell
npm test
npm run check
npx vitest run src/tests/unit/github-update.test.ts src/tests/unit/update-manager.test.ts
npx vitest run src/tests/unit/release-pipeline.test.mjs src/tests/unit/release-cos.test.mjs
```

发布前还要在隔离 Windows 运行器完成真实 2.0.0/2.1.0/2.2.0 → 2.2.1 安装矩阵，覆盖
相邻 delta、跨版本 full、损坏/缺失 delta 后的 full 兜底、Setup、启用更新器的 MSI 和
用户数据保留；用下载请求日志、实际字节数、包哈希和 Squirrel 日志证明 delta 被应用。
另测直连、系统代理、仅浏览器代理、失效代理、断网、TLS、超时、重定向、上传中断、幂等
重试和哈希冲突。Draft/模拟路由测试只能作为预发布证据，不能代替公开附件验收；公开
2.2.1 → 后续正式版本的最终链路需要相应版本发布授权。
