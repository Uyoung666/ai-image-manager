# AI Image Manager 发布手册

这份手册面向第一次发布 Windows 版本的同学。发布分为两个明确阶段：候选构建（candidate）和人工推广（promote）。候选工作流使用受保护的 `release-candidate` environment，推广工作流使用独立的 `release-stable` environment；两者都应配置必需审核者，分别作为候选和正式发布的人工审批门。候选构建可以上传测试对象，但绝不会改动 `stable/RELEASES`；只有推广工作流通过全部门禁后，才会公开 GitHub Release 并切换 COS stable 指针。

## 先记住三条规则

1. 版本号必须是稳定 SemVer：`MAJOR.MINOR.PATCH`，例如 `2.1.0`。`package.json`、`package-lock.json` 和 tag 必须一致，tag 写成 `v2.1.0`。
2. 先推送 tag 生成候选，再经过 `release-candidate` 审核并在 GitHub Actions 中输入确认短语推广。不要手工覆盖 COS 中已有的 immutable 包或删除 `RELEASES`。
3. 当前流水线不做付费 Authenticode 签名。安装包可以用于测试，但 Windows SmartScreen 的信任体验不能按“已签名”理解。

## 第一次发布或普通版本发布

### 1. 准备版本号

更新 `package.json` 后，使用 npm 的版本同步能力更新 `package-lock.json`，检查两个文件的版本相同。提交并推送代码，然后创建与版本完全一致的 tag：

```text
v2.1.0
```

不要用 `v2.1.0-rc.1` 作为正式推广版本；release guard 会拒绝 prerelease 和不一致的 lockfile。候选工作流也会通过 GitHub API 读取最新正式 Release，只有 API 明确返回 404（仓库还没有正式 Release）才允许 `--allow-initial` 首发。

### 2. 运行候选构建

推送 `v2.1.0` 自动触发 `.github/workflows/publish.yaml`。如果在 immutable `testing/runs/<run-id>`、`candidates/<版本>` 或 `downloads/<版本>` 尚未写入前失败，可以在 Actions 页面用同一个版本（不带 `v`）重跑；这不会创建新 tag。手动重跑仍从不可变 tag 构建应用，只会从触发它的 `main` 提交恢复 `scripts/release/` 和 `scripts/release-cos.mjs`，以便发布自动化本身的修复生效。若任一 immutable 对象已经写入，只有新构建字节完全相同才会被 COS 幂等接受；如果重建产生不同字节，必须递增 patch 版本并创建新 tag，不能覆盖原对象。

候选工作流依次执行（第一个 environment 审核在 job 开始前发生）：

- Windows、Node.js 22、`npm ci` 和 WiX 3.14 检查；
- `npm run check`、`npm test` 和仓库内真实 release guard（package、lock、tag、版本递增）；
- 用 `electron-forge publish --dry-run` 构建 Squirrel/WiX/ZIP，不上传 GitHub；
- 扫描唯一 `app.asar` 内全部 `.vite/build/**/*.js` 分块，确认精确 COS stable feed 已注入，旧 `update.electronjs.org/Uyoung666/ai-image-manager` feed 和运行时更新源覆盖入口均已消失；
- 检查 `RELEASES`、当前版本 full 包、Setup.exe、MSI 和 WiX 回滚/图标设置；
- 只把 `RELEASES`、上一版 build-base full 与当前 full/delta 上传到 COS testing run（Setup.exe 另进版本下载区，避免每次 testing/candidate 再重复存一份约 500MB 的安装器）；首个无基线版本只有当前 full；
- 用已验证的旧版 Setup/full 基线执行真实 Squirrel 更新，再启动 `app-<新版本>`；
- MSI 默认安装的专用 `Update.exe` 与 Squirrel 包兼容：从已有官方 MSI 起，必须用旧版 MSI 经 testing feed 自动更新到新版，再验证数据、启动和卸载；v2.1.0 是首个官方 MSI，只允许一次受版本号约束的默认/自定义目录 fresh-install 门禁；
- 上传 `candidates/<版本>` 的 Squirrel 工件；另将 Setup、MSI、ZIP、当前 full/delta 上传到 `downloads/<版本>`，由 release CLI 在该目录 materialize `SHA256SUMS.txt` 与 `provenance.json`（不把 Squirrel `RELEASES` 混入 flat 下载目录）；
- 生成 SHA-256 证据、提交 GitHub artifact attestation，并从 Forge dry-run 元数据创建 GitHub Draft，附上 `release-body.md`、`SHA256SUMS.txt` 和 `provenance.json`。

Setup 没有旧版公开工件或正确 SHA-256 时会明确失败。MSI 只有首个官方版本 v2.1.0 可以在三个旧 MSI 变量全部留空时走一次 fresh-bootstrap；从 v2.2.0 起缺少任一旧 MSI 变量都会失败，不能静默降级成只验证新装。

### 3. 推广候选

确认候选 workflow 成功、Draft 存在且证据 artifact 未过期后，运行 `.github/workflows/promote-release.yaml`，通过 `release-stable` 的第二个审核门并输入：

```text
version: 2.1.0
confirmation: PROMOTE 2.1.0
```

推广工作流会重新确认 tag、checkout commit、Draft、GitHub candidate run、`SHA256SUMS.txt`、`provenance.json`、attestation 和两条 installer smoke 标记；还会下载候选与证据 artifact，在公开 Draft 之前逐字节核对 COS candidate、COS 版本下载区和 GitHub Draft 资产。通过后先把 GitHub Draft 设为正式 Release，最后调用 `promote` 将 COS candidate 的包、`RELEASES` 和 full 包复制到 stable/build-base，`stable/RELEASES` 只在所有引用包校验并复制成功后写入。重试只对相同字节幂等；若上传前后重建产生不同字节，必须换新 patch 版本。

## COS 配置（腾讯云控制台）

仓库默认示例使用以下非秘密值：

```text
COS_BUCKET=ai-image-manager-1392398678
COS_REGION=ap-hongkong
COS_RELEASE_PREFIX=ai-image-manager
COS_PUBLIC_BASE_URL=https://ai-image-manager-1392398678.cos.ap-hongkong.myqcloud.com
```

发布工作流允许用同名 GitHub Actions Variables 覆盖默认值。对象前缀如下（`COS_RELEASE_PREFIX` 默认是 `ai-image-manager`）：

| 用途 | 对象目录 |
| --- | --- |
| 不可变版本下载 | `downloads/<version>/` |
| 候选 Squirrel feed | `updates/win32/x64/candidates/<version>/` |
| 本次测试 feed | `updates/win32/x64/testing/runs/<run-id>/` |
| 正式 Squirrel feed | `updates/win32/x64/stable/` |
| delta 构建基线 | `updates/win32/x64/build-base/` |

`COS_BUILD_BASE_URL` 必须是实际包含 `RELEASES` 的目录 URL，例如：

```text
https://ai-image-manager-1392398678.cos.ap-hongkong.myqcloud.com/ai-image-manager/updates/win32/x64/build-base
```

Forge 只在该目录的 `RELEASES` 能通过 HEAD 检查时设置 `AIM_SQUIRREL_REMOTE_RELEASES`，因此始终生成当前 full；有稳定构建基线才生成当前 delta。不要把 stable feed URL 填到 `AIM_SQUIRREL_REMOTE_RELEASES`，它必须指向 `build-base` 目录。生产应用的 `COS_APP_FEED` 示例是：

```text
https://ai-image-manager-1392398678.cos.ap-hongkong.myqcloud.com/ai-image-manager/updates/win32/x64/stable
```

它会作为 `AIM_UPDATE_BASE_URL` 编译时注入应用；候选 installer smoke 则临时使用本次 `testing/runs/<run-id>` URL。

控制台建议：

1. 桶保持私有，不要把整个桶设为公读；`candidates/*` 必须保持私有，只让 CI 读取。
2. 匿名主体只授予 `GetObject`/`HeadObject`，并且只覆盖以下最小前缀，不授予 `ListBucket`：`ai-image-manager/downloads/*`、`ai-image-manager/updates/win32/x64/stable/*`、`ai-image-manager/updates/win32/x64/build-base/*`、`ai-image-manager/updates/win32/x64/testing/runs/*`。不要把权限写成整个 `updates/*`，也不要把 `candidates/*` 放入匿名读策略。
3. 建立两个不同的 CAM 子账号：`release-candidate` 只能写 testing/candidates/downloads，`release-stable` 只能读 candidates/downloads 并写 stable/build-base。不要给候选账号写 stable 的能力。两组 `SecretId`、`SecretKey` 分别放进同名 GitHub Environment 的 Secrets（键名仍为 `COS_SECRET_ID`、`COS_SECRET_KEY`，如使用临时密钥再加 `COS_SESSION_TOKEN`），不要创建一把同时覆盖所有前缀的仓库级密钥。
4. 防盗链必须允许空 `Referer`。Squirrel/Windows Installer 的请求通常没有浏览器 Referer，拒绝空值会导致自动更新 404。空 Referer 无法阻止脚本直连，COS 也不能把它当作硬性防盗链；应依靠版本化对象、请求/流量告警和预算上限发现滥用。
5. 开启 COS 版本控制，保留旧的 `RELEASES` 和指针版本，便于审计和回滚。`testing/runs/*` 设置 7–14 天生命周期；`stable/*`、`downloads/*`、`build-base/*` 不设置自动过期，非当前版本也不要用无人审核的规则清理。
6. 开启请求量、流量、费用和异常下载告警，至少在预算的 50%/80%/100% 触发通知；为 COS 设定经负责人确认的月度预算上限，并说明超预算时先暂停推广/收紧匿名入口再调查，不依靠删除 `RELEASES` 回滚。

### 匿名只读桶策略

桶继续保持“私有读写”，然后在 **权限管理 → Bucket Policy** 添加下面这条最小匿名策略。它不允许列目录、上传或读取 candidate：

```json
{
  "version": "2.0",
  "statement": [
    {
      "effect": "allow",
      "principal": {
        "qcs": ["qcs::cam::anyone:anyone"]
      },
      "action": ["name/cos:GetObject", "name/cos:HeadObject"],
      "resource": [
        "qcs::cos:ap-hongkong:uid/1392398678:ai-image-manager-1392398678/ai-image-manager/downloads/*",
        "qcs::cos:ap-hongkong:uid/1392398678:ai-image-manager-1392398678/ai-image-manager/updates/win32/x64/stable/*",
        "qcs::cos:ap-hongkong:uid/1392398678:ai-image-manager-1392398678/ai-image-manager/updates/win32/x64/build-base/*",
        "qcs::cos:ap-hongkong:uid/1392398678:ai-image-manager-1392398678/ai-image-manager/updates/win32/x64/testing/runs/*"
      ]
    }
  ]
}
```

### 两个 CI 子账号的最小策略

把下面第一份策略绑定给候选子账号。上传工具会对不可变对象携带 `x-cos-forbid-overwrite: true`；策略也要求关键上传动作必须带这个头，避免未开启版本控制时意外覆盖同名对象。

```json
{
  "version": "2.0",
  "statement": [
    {
      "effect": "allow",
      "action": ["name/cos:GetObject", "name/cos:HeadObject"],
      "resource": [
        "qcs::cos:ap-hongkong:uid/1392398678:ai-image-manager-1392398678/ai-image-manager/downloads/*",
        "qcs::cos:ap-hongkong:uid/1392398678:ai-image-manager-1392398678/ai-image-manager/updates/win32/x64/candidates/*",
        "qcs::cos:ap-hongkong:uid/1392398678:ai-image-manager-1392398678/ai-image-manager/updates/win32/x64/testing/runs/*"
      ]
    },
    {
      "effect": "allow",
      "action": [
        "name/cos:PutObject",
        "name/cos:InitiateMultipartUpload",
        "name/cos:CompleteMultipartUpload"
      ],
      "resource": [
        "qcs::cos:ap-hongkong:uid/1392398678:ai-image-manager-1392398678/ai-image-manager/downloads/*",
        "qcs::cos:ap-hongkong:uid/1392398678:ai-image-manager-1392398678/ai-image-manager/updates/win32/x64/candidates/*",
        "qcs::cos:ap-hongkong:uid/1392398678:ai-image-manager-1392398678/ai-image-manager/updates/win32/x64/testing/runs/*"
      ],
      "condition": {
        "string_equal": {
          "cos:x-cos-forbid-overwrite": "true"
        }
      }
    },
    {
      "effect": "deny",
      "action": [
        "name/cos:PutObject",
        "name/cos:InitiateMultipartUpload",
        "name/cos:CompleteMultipartUpload"
      ],
      "resource": [
        "qcs::cos:ap-hongkong:uid/1392398678:ai-image-manager-1392398678/ai-image-manager/downloads/*",
        "qcs::cos:ap-hongkong:uid/1392398678:ai-image-manager-1392398678/ai-image-manager/updates/win32/x64/candidates/*",
        "qcs::cos:ap-hongkong:uid/1392398678:ai-image-manager-1392398678/ai-image-manager/updates/win32/x64/testing/runs/*"
      ],
      "condition": {
        "string_not_equal_if_exist": {
          "cos:x-cos-forbid-overwrite": "true"
        }
      }
    },
    {
      "effect": "allow",
      "action": [
        "name/cos:ListMultipartUploads",
        "name/cos:ListParts",
        "name/cos:UploadPart",
        "name/cos:AbortMultipartUpload"
      ],
      "resource": [
        "qcs::cos:ap-hongkong:uid/1392398678:ai-image-manager-1392398678/ai-image-manager/downloads/*",
        "qcs::cos:ap-hongkong:uid/1392398678:ai-image-manager-1392398678/ai-image-manager/updates/win32/x64/candidates/*",
        "qcs::cos:ap-hongkong:uid/1392398678:ai-image-manager-1392398678/ai-image-manager/updates/win32/x64/testing/runs/*"
      ]
    }
  ]
}
```

第二份策略绑定给正式推广子账号。COS 的 `Put Object Copy` 在 CAM 中是“源对象 `GetObject` + 目标对象 `PutObject`”，不是一个叫 `PutObjectCopy` 的 action。

```json
{
  "version": "2.0",
  "statement": [
    {
      "effect": "allow",
      "action": ["name/cos:GetObject", "name/cos:HeadObject"],
      "resource": [
        "qcs::cos:ap-hongkong:uid/1392398678:ai-image-manager-1392398678/ai-image-manager/downloads/*",
        "qcs::cos:ap-hongkong:uid/1392398678:ai-image-manager-1392398678/ai-image-manager/updates/win32/x64/candidates/*",
        "qcs::cos:ap-hongkong:uid/1392398678:ai-image-manager-1392398678/ai-image-manager/updates/win32/x64/stable/*",
        "qcs::cos:ap-hongkong:uid/1392398678:ai-image-manager-1392398678/ai-image-manager/updates/win32/x64/build-base/*"
      ]
    },
    {
      "effect": "allow",
      "action": ["name/cos:PutObject"],
      "resource": [
        "qcs::cos:ap-hongkong:uid/1392398678:ai-image-manager-1392398678/ai-image-manager/updates/win32/x64/stable/*.nupkg",
        "qcs::cos:ap-hongkong:uid/1392398678:ai-image-manager-1392398678/ai-image-manager/updates/win32/x64/build-base/*.nupkg"
      ],
      "condition": {
        "string_equal": {
          "cos:x-cos-forbid-overwrite": "true"
        }
      }
    },
    {
      "effect": "deny",
      "action": ["name/cos:PutObject"],
      "resource": [
        "qcs::cos:ap-hongkong:uid/1392398678:ai-image-manager-1392398678/ai-image-manager/updates/win32/x64/stable/*.nupkg",
        "qcs::cos:ap-hongkong:uid/1392398678:ai-image-manager-1392398678/ai-image-manager/updates/win32/x64/build-base/*.nupkg"
      ],
      "condition": {
        "string_not_equal_if_exist": {
          "cos:x-cos-forbid-overwrite": "true"
        }
      }
    },
    {
      "effect": "allow",
      "action": ["name/cos:PutObject"],
      "resource": [
        "qcs::cos:ap-hongkong:uid/1392398678:ai-image-manager-1392398678/ai-image-manager/updates/win32/x64/stable/RELEASES",
        "qcs::cos:ap-hongkong:uid/1392398678:ai-image-manager-1392398678/ai-image-manager/updates/win32/x64/build-base/RELEASES"
      ]
    }
  ]
}
```

如果开启版本控制，腾讯云会保留每次覆盖的历史版本，但 `x-cos-forbid-overwrite` 本身不再阻止产生新版本；此时防误覆盖主要依靠“两把最小权限密钥 + 工作流字节校验 + COS 历史版本”。这是可回滚性与硬性禁止同名覆盖之间的取舍，本项目选择保留可回滚能力。

## 哈希、attestation 和无签名边界

候选证据 artifact 包含 `SHA256SUMS.txt`、版本/tag/commit 元数据和 smoke 状态；GitHub Draft 还附有 flat 下载目录 materialize 的 `SHA256SUMS.txt` 与 `provenance.json`。需要人工核查时，在仓库目录执行：

```powershell
Get-FileHash .\Setup.exe -Algorithm SHA256
gh attestation verify .\Setup.exe --repo Uyoung666/ai-image-manager
```

实际文件名以候选 artifact 为准。推广工作流会对下载的 `.exe`、`.msi`、`.nupkg` 和 `.zip` 全部执行 attestation 验证，不接受只看文件名或只看 GitHub Release 页面。

当前 `forge.config.ts` 的 `postMake` 仍用 `rcedit` 为 Squirrel Setup.exe 设置图标，这是无签名阶段的现状。将来接入签名时，必须先完成图标修改，再签名并重新生成/验证哈希；不要把一个已经签名的文件再次用 rcedit 改写。签名不是本阶段的付费硬门禁，但接入后应把签名验证作为独立门禁。

## v2.1.0 bridge

v2.1.0 是从旧 GitHub 更新 feed 迁移到 COS 的桥接版本：

1. 继续保留 GitHub Draft → 正式 Release 的发布步骤，让仍运行 v2.0.0 的客户端可以先通过旧 feed 获得 v2.1.0。
2. v2.1.0 本身把 `AIM_UPDATE_BASE_URL` 编译为 COS stable feed。首次迁移没有 `build-base/RELEASES` 时，候选构建只生成 full 包，不配置 `remoteReleases`，不需要先运行 bootstrap；候选→推广成功后会自然建立当前版本的 `build-base/RELEASES`，后续版本才会使用该目录生成 delta。
3. 仍在运行 v2.0.0 的客户端继续从旧 GitHub feed 获取 v2.1.0；桥接版安装完成后才使用 COS stable feed。`guard --allow-initial` 只表示 GitHub API 没有任何正式 stable Release，不能绕过 smoke、hash、Draft 或候选→推广门禁。

## 回滚

回滚不等于删除对象：

- 如果新版本尚未推广，保留 Draft 和 COS candidate；若 testing/candidate/downloads 的 immutable 对象尚未写入，可重新生成同一 tag 的候选，否则只有字节完全相同才允许重试，不同字节必须创建新 patch 版本；不要覆盖同名 immutable 对象。
- 如果 stable 已切换但新客户端尚未大规模更新，可用已验证的旧 candidate 重新执行 `node scripts/release-cos.mjs promote --version <旧版本>`，让 stable/build-base 指针回到旧版本。先确认旧 candidate 的 `RELEASES`、包 hash 和可用性，推广命令会再次校验引用的 full/delta 包。
- 已经安装新版本的客户端通常不会自动降级。此时发布更高版本的修复版本，并保留旧版对象和审计证据；不要依赖删除 `RELEASES` 来阻止客户端更新。
- COS 版本控制和 GitHub Actions evidence 是回滚审计依据。回滚后重新运行 hash、attestation 和 smoke，确认 stable feed 可下载，再通知用户。

## 需要配置的旧版 smoke 变量

在仓库 Actions Variables 中配置公开 HTTPS 地址及对应 SHA-256（不是 Secrets）：

```text
AIM_OLD_SETUP_URL=https://github.com/Uyoung666/ai-image-manager/releases/download/v2.0.0/AI.Image.Manager-2.0.0.Setup.exe
AIM_OLD_SETUP_SHA256=9e1bd7c60ea4fbe051da51e758491822a6417027b5a674103e0ac72b491f9ff0
AIM_OLD_SETUP_VERSION=2.0.0
AIM_OLD_SQUIRREL_FULL_URL=https://github.com/Uyoung666/ai-image-manager/releases/download/v2.0.0/ai-image-manager-2.0.0-full.nupkg
AIM_OLD_SQUIRREL_FULL_SHA256=75ff5c385fae9551a6c3f1035e3142de4c1c1d05c2f84e4519ebc1fc8d956400
# v2.1.0 候选构建时下面三项全部不创建/留空
# v2.1.0 正式发布后，为 v2.2.0 改成该 Release 中 MSI 的固定 URL、SHA-256 和版本
AIM_OLD_MSI_URL=<v2.1.0 官方 MSI 的固定 HTTPS URL>
AIM_OLD_MSI_SHA256=<v2.1.0 官方 MSI 的 SHA-256>
AIM_OLD_MSI_VERSION=2.1.0
```

仓库现有 v2.0.0 GitHub Release 只有 Setup/full/ZIP/RELEASES，没有 MSI，所以 v2.1.0 被工作流硬编码为“首个官方 MSI”：只有版本恰好为 2.1.0 且三个旧 MSI 变量全部为空，才允许以默认目录和自定义目录的新装、启动、`Update.exe` 存在性与卸载作为首发门禁。这个例外不会延续到后续版本；v2.1.0 发布后必须立即记录其 MSI URL 和真实 SHA-256，v2.2.0 起强制真实旧 MSI 自动升级。

Setup smoke 会校验旧版 Setup 和 full NUPKG，安装旧版后用同一个 user-data 目录启动旧版并写入 marker，再使用旧版 `Update.exe --update` 指向本次 testing feed；它会确认 `app-<新版本>` 启动且 marker 仍在，最后等待卸载后的文件消失，并对候选 Setup.exe 另做 fresh install、启动和卸载验证。后续版本的 MSI smoke 同样从已验证的旧 MSI 安装开始，通过 MSI 自带的兼容 `Update.exe --update` 走 testing feed，核对产品注册版本、新版启动和 user-data marker，再对候选 MSI 做自定义目录安装/启动与卸载。变量不完整、URL 非 HTTPS、候选版本不高于旧版或 hash 不匹配都会让候选失败。
