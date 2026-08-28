# 插件开发指南（v2 主题与 v3 语言包）

AI Image Manager 的公开插件是只读的声明式主题包或语言包。插件不能运行代码，也不能读取宿主文件或主动联网；主题和语言资源由应用安全地解释，插件作者只需要提供 JSON 和（主题包的）可选媒体资源。

## 安全边界

v2 主题包只允许使用 `plugin.json`、`theme.json` 和 `assets/` 下的图片/视频；v3 语言包只允许使用 `plugin.json`、`signature.json` 以及 `locales/<tag>/renderer.json` 和 `locales/<tag>/main.json`。包内不允许 JavaScript、HTML、CSS、字体、可执行文件、网络 URL、`data:` URL 或脚本注入语法。应用会在导入时重新校验 ZIP 路径、重复条目、符号链接、资源扩展名、资源 MIME、解压大小、语言资源结构和签名；CLI 的校验不能替代宿主的最终校验。

正式 v3 语言包必须由应用构建时注入的官方 Ed25519 keyring 验签；源码默认不信任任何临时公钥。发布构建应在受审计的版本化模块中维护公钥，并把该模块导出的公钥映射传给 `configurePluginManager(builtins, keyring)`（可先用 `createPluginTrustedKeyring(keyring)` 校验并冻结）；不要从运行时环境变量或插件目录读取信任锚。当前源码默认 keyring 为空，因此未注入发布 keyring 的构建会拒绝所有正式语言包。开发者目录可以没有签名，但只在开发者模式中加载，并始终标记为 `developer` 信任级别。

不要把用户私密图片、凭据或绝对路径放入包中。`image`/`video` 设置表示“让用户在应用内选择资源”，不是把用户文件复制进插件；主题中应使用 `{"setting":"id"}` 绑定这类设置。

## 包结构

```text
my-plugin/
├── plugin.json
├── theme.json
└── assets/
    ├── optional-wallpaper.png
    └── optional-loop.webm
```

v3 语言包使用以下固定布局（一个包只提供一个规范化 BCP 47 locale）：

```text
my-locale/
├── plugin.json
├── signature.json
└── locales/
    └── ja-JP/
        ├── renderer.json
        └── main.json
```

主题包根目录只能有 `plugin.json` 和 `theme.json`；`assets/` 可为空，也可以包含嵌套目录。语言包根目录只能有 `plugin.json` 和 `signature.json`，资源固定放在 `locales/<tag>/` 下。主题资源只能使用 `.png`、`.jpg`、`.jpeg`、`.webp`、`.avif`、`.gif`、`.mp4` 或 `.webm` 扩展名。不要放 README、源文件或构建产物；说明文字应放在插件仓库或发行页面，而不是 `.aim-plugin` 包内。

## 清单字段

`plugin.json` 的主题包必须使用以下 v2 固定字段：

```json
{
  "manifestVersion": 2,
  "apiVersion": 2,
  "id": "com.example.layered-aurora",
  "version": "1.0.0",
  "name": { "en": "Layered Aurora", "zh": "分层极光" },
  "description": { "en": "A declarative theme.", "zh": "声明式主题。" },
  "author": { "name": "Example Studio", "url": "https://example.com" },
  "engine": { "minAppVersion": "2.0.0" },
  "capabilities": ["theme"],
  "themeFile": "theme.json",
  "settingGroups": [],
  "settings": []
}
```

- `id` 是反向域名形式的小写标识符，例如 `com.example.layered-aurora`；它安装后会成为插件目录的一部分。
- `version` 和 `engine.minAppVersion` 都是 `MAJOR.MINOR.PATCH` SemVer，可带合法的 prerelease/build 元数据。发布新包时必须递增版本，不能用同一版本覆盖已安装包。
- `name`、`description` 必须同时提供 `en` 与 `zh` 文案；`author` 是 `{name,url?}`，URL（如提供）必须是无凭据的 HTTP(S) 地址。
- `capabilities` 当前必须精确为 `["theme"]`；`themeFile` 当前必须精确为 `theme.json`。
- `settingGroups` 是分组数组（可以为空），每项有唯一 `id` 和双语 `label`，设置用 `group` 引用它；分组和设置都可声明 `order`。
- 设置最多 64 项，主题最多 4 层。层的类型为 `solid`、`linearGradient`、`radialGradient`、`image`、`video` 或 `aurora`。

语言包使用独立的 v3 清单，不得混用主题字段：

```json
{
  "manifestVersion": 3,
  "apiVersion": 3,
  "id": "com.example.japanese-locale",
  "version": "1.0.0",
  "name": { "en": "Japanese", "ja-JP": "日本語" },
  "description": { "en": "Japanese UI translation.", "ja-JP": "日本語 UI 翻訳。" },
  "author": { "name": "Example Studio" },
  "engine": { "minAppVersion": "2.0.0" },
  "capabilities": ["locale"],
  "locale": {
    "tag": "ja-JP",
    "nativeName": "日本語",
    "fallback": "en",
    "direction": "ltr",
    "catalogVersion": "1.0.0",
    "rendererFile": "locales/ja-JP/renderer.json",
    "mainFile": "locales/ja-JP/main.json"
  }
}
```

v3 的 `name`/`description` 是以规范化 BCP 47 tag 为键的语言映射，必须同时包含 `en` 与目标 tag；`fallback` 固定为 `en`，首版 `direction` 固定为 `ltr`。两个资源文件只能包含对象、数组和字符串，字符串不能含 HTML、脚本 URL 或危险控制字符。语言包不提供 settings、theme、icon 或媒体资源。

`signature.json` 的格式为 `{ "algorithm": "ed25519", "keyId": "release-1", "signature": "<base64>" }`。签名输入是除 `signature.json` 外所有文件按规范化 `/` 路径排序后的无空白 JSON 数组，每项严格按 `path`、`size`、`sha256` 字段排列；`sha256` 是文件字节的小写 SHA-256。签名私钥只能从 CLI 显式路径或外部环境变量路径读取，不会写入插件或应用存储；环境变量仅用于 CLI 发布机读取私钥，不能用于应用运行时 keyring。

## 设置、分组与条件显示

设置支持 `boolean`、`number`、`select`、`color`、`image`、`video`。每项至少包含 `id`、`type`、双语 `label` 和与类型匹配的 `defaultValue`；数字可声明 `min`、`max`、`step`，选择项需要带双语标签的 `options`，图片和视频的默认值必须是 `null`。

```json
{
  "id": "auroraIntensity",
  "type": "number",
  "label": { "en": "Aurora intensity", "zh": "极光强度" },
  "defaultValue": 0.7,
  "min": 0,
  "max": 1,
  "step": 0.05,
  "group": "effects",
  "visibleWhen": { "setting": "showAurora", "equals": true }
}
```

`visibleWhen` 只能引用已声明的设置，并且比较值必须是相同类型：布尔设置比较布尔值，数字设置比较有限数字，选择设置比较已声明的选项，颜色比较安全颜色，图片/视频比较 `null` 或字符串值。可以使用 `equals`、`notEquals`、`value`（`equals` 的简写）或 `in`（非空且无重复数组）；不要用任意表达式，也不要形成自引用或循环。

主题属性使用强类型对象绑定：`{"setting":"accentColor"}` 只能绑定 `color` 设置，`{"setting":"auroraIntensity"}` 只能绑定 `number` 设置，图片层的 `asset` 只能绑定 `image`，视频层只能绑定 `video`。引用不存在的设置或类型不匹配都会被拒绝。用户选择的媒体应使用绑定，而不是硬编码绝对路径。

## 主题与分层 Aurora

`theme.json` 最多有四层；每层都必须有唯一的 `id`。层类型为 `solid`、`linearGradient`、`radialGradient`、`image`、`video` 或 `aurora`：

```json
{
  "layers": [
    { "id": "base", "type": "solid", "color": "#07111f" },
    {
      "id": "gradient",
      "type": "linearGradient",
      "angle": 132,
      "stops": [
        { "color": { "setting": "accentColor" }, "offset": 0 },
        { "color": "#312e81", "offset": 1 }
      ]
    },
    {
      "id": "aurora",
      "type": "aurora",
      "colors": ["#22d3ee", { "setting": "accentColor" }, "#a78bfa"],
      "intensity": { "setting": "auroraIntensity" }
    }
  ]
}
```

渐变色标的 `offset` 在 `0..1` 之间，且字面量色标严格递增并从 `0` 到 `1`。v2 颜色字面量只能是 `#RRGGBB` 或 `#RRGGBBAA`，短 hex、`rgb()`、`hsl()`、`url()` 均不接受。层上的 `opacity`、`angle`、`speed` 等数值属性可以绑定 `number` 设置；颜色属性只能绑定 `color` 设置。`image`/`video` 层的资源路径必须是 `assets/...` 的安全相对路径，或是正确类型的设置绑定。可选的 `material.kind` 为 `none`、`solid`、`glass`、`mica`、`acrylic`；`tokens` 只能使用宿主批准的白名单颜色 token 名称，并且值只能是安全颜色字面量或颜色设置绑定，不支持数值/尺寸 token。

## 导入、更新与卸载语义

- 导入先显示预检信息，包括插件身份、版本关系、能力、兼容性、包大小和 SHA-256；用户确认后才安装。新安装不会自动启用，也不会替换当前启用的主题。
- v3 语言包的预检还会显示 locale、签名状态、签名 keyId 和可用的覆盖率信息；没有官方签名的正式 `.aim-plugin` 会被拒绝。语言包不会通过主题插件的启停开关激活。
- 已安装的相同版本不能覆盖，正式包不能降级。升级会保留原有设置、启用状态和用户资源，并保留最后一次成功激活的版本用于失败回滚。
- 用户通过设置项选择的图片/视频会复制到应用托管目录；主题只拿到不透明的宿主资源 URL，不会获得原始文件路径。替换、移除或重置资源时会清理对应托管副本。
- 卸载确认框默认同时删除插件设置和托管资源；取消勾选可以只删除插件包并保留用户数据，便于以后重新安装恢复。无论是否保留数据，插件包版本本身都会移除。

## 开发模式工作流

1. 从 `examples/plugins/layered-aurora` 复制一个最小插件目录，先只改 JSON。
2. 在仓库根目录执行 `npm run plugin:validate -- <插件目录>`。命令会检查 v2 字段、条件、绑定、层数、资源路径和多余文件。
3. 打开应用设置页的开发者模式，选择“加载插件目录”，再点击“手动重新加载”查看变更。开发目录不会复制到托管插件目录；当前能力不提供热更新，修改文件后必须手动重新加载。
4. 不要假设应用重启后会自动重新加载开发目录；如果目录插件没有出现或内容没有更新，请按当前应用版本能力在设置页再次手动重新加载。
5. 发布前仍应重新验证并打包，然后在应用设置页导入 `.aim-plugin` 做一次发布包测试；如应用已经安装旧版本，先卸载或提高 `version`，避免同版本冲突。

语言包目录可使用同一个 `validate` 命令。它会检查 v3 清单、BCP 47 tag、两个固定资源路径、JSON 结构、额外文件和签名格式；签名者是否属于官方 keyring、签名是否与文件内容匹配，仍由宿主在导入时完成。发布签名时从外部文件读取 Ed25519 私钥：

打包命令：

```powershell
npm run plugin:pack -- examples/plugins/layered-aurora --out .\dist\plugins

# v3 语言包：--sign-key 只接受私钥文件路径，--key-id 只写入签名元数据
node scripts/plugin-cli.mjs pack <语言包目录> --out .\dist\plugins --sign-key <私钥文件> --key-id <发布 keyId>
```

输出文件名固定为 `<id>-<version>.aim-plugin`。CLI 会先验证，再以固定条目顺序（主题为 `plugin.json`、`theme.json`、资源；语言包为 `plugin.json`、`signature.json`、语言资源；均按规范化路径排序）生成 ZIP；同一源目录和签名输入重复打包应产生相同字节内容。

也可以直接检查已有包：

```powershell
npm run plugin:validate -- .\dist\plugins\com.aiimagemanager.layered-aurora-1.0.0.aim-plugin
```

## 发布检查表

- [ ] v2 主题包的 `manifestVersion`/`apiVersion` 为 `2`，`capabilities` 精确为 `["theme"]`，`themeFile` 为 `theme.json`；或 v3 语言包的两个版本字段为 `3`，`capabilities` 精确为 `["locale"]`。
- [ ] v3 语言包只有一个规范化 BCP 47 tag，`fallback` 为 `en`、`direction` 为 `ltr`，并包含固定的 renderer/main JSON 和官方 Ed25519 签名。
- [ ] ID 是小写反向域名，版本是新的合法 SemVer，最低应用版本写得准确。
- [ ] 主题包 `en`/`zh` 文案完整；设置类型、默认值、范围、选项和分组引用一致。语言包的 `name`/`description` 同时包含 `en` 和目标 tag。
- [ ] `visibleWhen` 只引用已声明设置，比较值类型正确且无循环；所有 `{ "setting": "id" }` 绑定均为强类型绑定。
- [ ] 主题层数不超过 4、每层 ID 唯一，所有资源均在 `assets/` 且扩展名和实际 MIME 匹配。
- [ ] 包内没有 JS/HTML/CSS、网络 URL、绝对路径、符号链接、隐藏构建产物或额外文件。
- [ ] 在 `720×480`、`900×600`、`1280×800` 下检查主题设置面板；同时测试启用、禁用、重新导入和卸载。
- [ ] 执行 `npm run plugin:validate -- <目录>` 与 `npm run plugin:pack -- <目录> --out <输出目录>`，保存生成的 `.aim-plugin` 和校验日志。

## 错误排查

| 报错 | 处理 |
| --- | --- |
| `manifestVersion and apiVersion must both be 2` | 检查两个版本字段，不要混用 v1 清单。 |
| `id must be a reverse-domain id` | 使用全小写并至少包含一个点，例如 `org.example.my-theme`。 |
| `themeFile must be "theme.json"` | 把主题文件放在根目录并固定命名。 |
| `locale package must contain signature.json` / `signature` | 为正式语言包使用外部 Ed25519 私钥重新打包，并确认 keyId 已在发布版官方 keyring 中。 |
| `locale bundle ...` | 语言资源只能使用对象、数组和字符串；移除 HTML、脚本 URL、控制字符或超限内容。 |
| `references unknown setting` | 检查绑定或 `visibleWhen.setting` 的拼写，先声明设置再引用。 |
| `binding must target ...` | 绑定目标类型必须匹配属性：颜色、数值、图片和视频不能互换。 |
| `references missing asset` | 使用 `assets/` 下的相对路径，并确认文件已加入包。 |
| `contains an extra file` / `unsupported asset` | 移除 README、源文件或不支持扩展名；说明文字放在仓库文档。 |
| `cannot contain symlinks` / `unsafe path` | 将资源复制到插件目录，不能使用符号链接、`..`、绝对路径或反斜杠穿越。 |
| 导入后显示“无效” | 重新运行 CLI，再确认资源 MIME、ZIP 没有被二次工具改写，并查看应用日志中的插件错误。 |
