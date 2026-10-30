# 应用图标资源

2026-10-30 按用户提供的紫色 AM / 白色圆角底板图标替换。母版为 `assets/icon.png`，所有尺寸由 `npm run assets:brand` 确定性生成，不需要再次调用 AI。

使用内置 GPT 生图工具，以用户附件为编辑目标。最终采用第一版保留字形的结果，并用规则圆角底板清理残留边缘杂点；未采用第二版变色结果。

实际第一版提示词：

> Use case: precise-object-edit. Edit target: attached application icon. Produce one clean production-ready square 1024x1024 application icon. Change ONLY the rough noisy perimeter and stray pixels: smooth the white rounded-square tile edges and remove debris outside it. Preserve the exact purple AM monogram silhouette, its connected strokes and cutouts, its purple color, the white tile, original composition, proportions and whitespace. Tile outside must be genuinely transparent alpha, no black backdrop. Keep the artwork faithful to reference, flat, crisp antialiasing. Do not add text, shadows, 3D, gradients or decorations. The letters must retain the exact original geometry, do not redesign.

PNG 尺寸：16、20、24、32、40、48、64、128、180、256、512、1024。ICO 图层：16、20、24、32、40、48、64、128、256。

客户端标题栏、引导和版本介绍共用母版；Windows 主窗口、托盘、开发加载窗口共用 ICO。Forge 将 PNG/ICO 同时打包，Setup、更新器、MSI 和快捷方式共用 ICO。安装器图片由同一母版重新合成。

官网页面/分享使用 512px，Next.js 文件约定生成 favicon、icon 和 180px Apple 图标。官网 `/icon.ico` 用于 Squirrel 卸载列表；正式发布前须先核验该地址部署成功。历史截图保持真实来源。

## 验证结果（2026-10-30）

- 内置 GPT 生图编辑后保存母版，全尺寸生成命令通过；12 种 PNG、9 图层 ICO、MSI 背景和静态安装 GIF 均已检查。
- Windows EXE、Setup、更新器、MSI 的实际内嵌图标与母版 ICO 一致；本地分发包位于 `out/make/`。
- 本次相关单测 40 项通过；Electron 响应式和启动窗 E2E 16 项通过。
- 官网 lint、TypeScript、生产静态构建通过；首页/指南通过三语、深浅主题、四种视口共 48 组验证。
- 本次变更文件的 Biome 检查通过。全仓检查存在 116 处格式/lint 错误，未改动无关文件。
- 全量单测为 2793 通过、3 失败：Tailwind 扫描范围差异（zoom-out）、COS SDK 超时、选片项目目录重定位 EPERM；失败日志保留在 `.test-runtime/icon-refresh-20261030/evidence/`。
- 本机没有 Windows Sandbox，未执行隔离安装后的快捷方式/托盘/卸载列表系统界面验收；已完成真实安装包资源验证。
- 构建仅在 preMake 阶段将 TEMP/TMP 指向仓库内 maker 缓存，兼容 Squirrel 旧资源工具对中文临时路径的限制。
- 本次未提交、推送、发布或部署；官网在线 ICO 须在后续授权部署后验证。

## 任务栏分组补充修复

开发进程原先使用与正式安装版相同的 Windows AppUserModelID，可能被关联到旧安装快捷方式；仅设置 BrowserWindow.icon 不能完整指定任务栏分组图标。现为开发版分配独立 identity，并为主窗口与开发启动窗设置 setAppDetails（图标路径、AppID、重启命令和显示名称）。正式版 identity 保持与安装快捷方式一致。

相关单测 30 项通过；任务栏配置须在主进程重新启动后生效，刷新渲染页面不会重新设置现有窗口的 Windows 属性。
任务栏补充修复的真实 Electron E2E 3 项通过，验证主窗口与开发启动窗均设置新任务栏属性；临时测试数据已清理。
