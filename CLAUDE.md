# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 本地 AI 图片管理器：Electron + React + TypeScript
> 版本：v0.2.0 — AI 核心就绪

---

## 项目概述

一款 Windows 桌面应用，提供本地 AI 图片浏览、搜索和管理能力。
- 双击 exe 即用，100% 本地处理，零数据上传
- CLIP 语义搜索（中/英自然语言）、以图搜图、智能去重、AI 自动标签
- EXIF 仪表盘可视化拍摄习惯
- 参考设计系统：Linear Dark（详见 `DESIGN.md`）

**核心技术栈**: Electron 41 + React 19 + TypeScript 6 (strict) + Vite 8 + Tailwind 4 + oRPC + better-sqlite3/Drizzle ORM + sharp + Transformers.js/LanceDB

> **已知限制**: ONNX WASM 后端与 sharp/libvips 共享 GLib，在同一进程中加载会冲突。生产代码通过进程隔离 (Worker) 处理。

---

## 项目结构

```
src/
├── main.ts                    # Electron 主进程入口
├── preload.ts                 # preload 脚本（oRPC MessagePort 桥接）
├── renderer.ts                # React 渲染入口
├── app.tsx                    # App 根组件
├── routeTree.gen.ts           # TanStack Router 自动生成的路由树
│
├── actions/                   # 前端 action 封装（IPC 调用 + 状态管理）
├── components/                # React 组件
│   └── ui/                    # shadcn/ui 组件
├── routes/                    # TanStack Router 文件路由
│   ├── __root.tsx             # 根路由（BaseLayout）
│   ├── index.tsx              # 主页：照片浏览 / 搜索
│   ├── albums.tsx             # 相册列表
│   ├── albums.$albumId.tsx    # 相册详情
│   ├── people.tsx             # 人物识别列表
│   ├── people.$identityId.tsx # 人物详情
│   ├── duplicates.tsx         # 重复照片管理
│   ├── dashboard.tsx          # EXIF 仪表盘
│   ├── trash.tsx              # 最近删除（软删除恢复）
│   └── settings.tsx           # 设置页面
├── layouts/                   # 布局组件
│
├── ipc/                       # oRPC IPC 层
│   ├── router.ts              # 路由聚合（albums, cloud, faces, photos, settings, shell, theme, window, app）
│   ├── handler.ts             # RPCHandler 实例
│   ├── manager.ts             # 渲染进程 IPC 客户端
│   ├── context.ts             # IPC 上下文（主窗口引用）
│   └── photos/                # 照片管理模块（核心业务）
│       ├── index.ts           # 导出全部 handler
│       └── handlers/          # 按职责拆分
│           ├── listing.ts     # 扫描、文件夹、列表、详情
│           ├── mutations.ts   # 删除、重命名、格式转换
│           ├── search.ts      # 文本搜索、以图搜图、复合搜索
│           ├── ai.ts          # AI 索引、标签生成
│           ├── tags.ts        # 标签 CRUD
│           ├── stats.ts       # 统计、去重
│           ├── export.ts      # 导出 ZIP + HTML 画廊
│           └── shared.ts      # 共享 schema
│
├── db/                        # 数据库层
│   ├── schema.ts              # Drizzle ORM Schema
│   └── index.ts               # 数据库初始化 + 连接管理
│
├── services/                  # 核心服务（仅在主进程运行）
│   ├── indexer.ts             # 索引引擎（扫描 + EXIF + 监听）
│   ├── thumbnailer.ts         # 缩略图服务（三级缓存）
│   ├── ai-embedder.ts         # AI 嵌入服务（CLIP + LanceDB）
│   ├── face-detector.ts       # 人脸检测 + 聚类
│   ├── dedup-service.ts       # 重复检测（pHash + CLIP）
│   ├── smart-album-engine.ts  # 智能相册规则引擎
│   └── ai/                    # AI 子模块（模型加载/搜索/标签）
│
├── localization/              # i18next 国际化
├── styles/                    # Tailwind v4 + Linear 主题变量
└── tests/
    ├── unit/                  # Vitest 单元测试
    └── e2e/                   # Playwright 端到端测试
```

---

## 架构约定

### 进程架构

```
Main Process（主进程）
  ├── 数据库：better-sqlite3 + Drizzle ORM
  ├── 图片处理：sharp（子进程 fork）
  ├── AI 推理：Transformers.js + LanceDB
  ├── 文件监听：chokidar
  ├── 缩略图生成：三级缓存（内存 LRU → 磁盘 → 按需）
  └── IPC Server：oRPC MessagePort

AI Workers（独立进程，避免 ONNX/sharp 冲突）
  ├── scripts/embed-worker.mjs  # CLIP 嵌入向量生成
  └── scripts/face-worker.mjs   # 人脸检测 + 特征提取

Renderer Process（渲染进程）
  ├── React 19 + TanStack Router
  ├── shadcn/ui 组件
  ├── IPC Client：oRPC Client（类型安全调用主进程）
  └── 状态管理：TanStack Query + React state
```

Workers 通过 `forge.config.ts` 的 `extraResource` 打包，运行时从 `process.resourcesPath` 加载。

### 主进程构建（Vite ESM 输出）

主进程通过 Vite 构建，输出格式为 **ESM**（`formats: ["es"]`）。ESM 环境中 **没有 `require()` 函数**。

**关键规则：在 `src/main.ts` 或主进程代码中新增 npm 依赖时，必须将其加入 `vite.main.config.mts` 的 `rollupOptions.external` 列表。**

原因：如果一个 CJS 包（内部使用 `require()`）被 Vite 打包进 ESM 输出，运行时会报错 `Calling 'require' for "node:xxx" in an environment that doesn't expose the 'require' function`。将其标记为 external 后，Electron 运行时直接从 node_modules 加载，避免此问题。

**当前 external 列表**（`vite.main.config.mts` → `rollupOptions.external`）:
`electron`, `better-sqlite3`, `sharp`, `@lancedb/lancedb`, `@lancedb/lancedb-win32-x64-msvc`, `@xenova/transformers`, `chokidar`, `exifr`, `lru-cache`, `p-queue`, `electron-store`, `@claudiu-ceia/dhash`, `archiver`, `update-electron-app`

**已踩坑的包**:
- `archiver` v8 — 纯 ESM，API 为 `new ZipArchive(options)`（不是工厂函数）
- `update-electron-app` — CJS 包，必须 external

### IPC 通信模式

本项目使用 **oRPC** 而非传统的 `ipcRenderer.invoke`。

**主进程注册 handler**（`src/ipc/photos/handlers/*.ts`）:
```typescript
import { os } from "@orpc/server";
import { z } from "zod";

export const listPhotos = os
  .input(z.object({ folderId: z.number().optional() }))
  .handler(async ({ input }) => {
    const db = getDatabase();
    return db.select().from(photos).where(eq(photos.folderId, input.folderId)).all();
  });
```

**渲染进程调用**:
```typescript
import { ipc } from "@/ipc/manager";
const result = await ipc.client.photos.listPhotos({ folderId: 1 });
```

**规则**:
- Handler 必须使用 Zod schema 验证输入（`.input()` 在 `.handler()` 之前）
- 所有数据库访问必须在主进程（handler 内）
- 渲染进程不得直接引入 `better-sqlite3`、`sharp`、`chokidar` 等 Node.js 模块
- 新 handler 在 `src/ipc/photos/handlers/` 下按职责创建，然后在 `src/ipc/photos/index.ts` 导出
- 新 IPC 模块在 `src/ipc/<模块名>/` 下创建，然后在 `router.ts` 注册

**IPC 模块注册表**（`src/ipc/router.ts`）:
`albums`, `cloud`, `faces`, `photos`, `settings`, `theme`, `window`, `app`, `shell`

### 数据库

- **ORM**: Drizzle ORM（类型安全、轻量）
- **引擎**: better-sqlite3（同步 API、适合 Electron 主进程）
- **Schema**: `src/db/schema.ts` 定义所有表
- **迁移**: `npx drizzle-kit generate` 生成 → `npm run db:migrate` 执行
- **运行时路径**: `%APPDATA%/ai-image-manager/data/ai-image-manager.db`
- **配置**: WAL 模式 + 外键强制 + 5s 忙等待

### 设计系统

遵循 **Linear Dark** 设计规范（详见 `DESIGN.md`）。

**核心约束**:
- 字重上限 590（绝不用 700+）
- 强调色 #5E6AD2 每屏最多用于 1 个主操作
- 暗色模式用亮度层级替代阴影（4 个表面层级）
- 圆角统一：4/6/8/12/full 五档
- 间距基准：4px 网格 + 特殊值 7px/11px（光学补偿）
- 字体：Inter Variable + JetBrains Mono
- 正文颜色 #f7f8f8（非纯白，护眼）

### 性能约束

- 缩略图必须生成缓存（禁止原图加载到网格）
- 虚拟滚动处理 1 万+ 图片（避免全量 DOM）
- AI 推理异步执行（不阻塞主窗口）
- 索引扫描批量执行（每次一个文件，可暂停/恢复）
- 不允许 `ipcRenderer.sendSync()`（阻塞 UI 线程）

### 安全约束

- `nodeIntegration: false` — 渲染进程无 Node.js 权限
- `contextIsolation: true` — preload 隔离
- 所有 IPC 调用通过 oRPC 类型安全桥接
- 文件路径验证（防止路径遍历）
- 不收集遥测数据（opt-in 除外）

### Native 模块重建

`postinstall` 脚本自动执行 `electron-rebuild -f -w better-sqlite3,sharp,@lancedb/lancedb,@xenova/transformers`。如果 `npm install` 后运行时报 native 模块加载错误，手动执行 `npx electron-rebuild -f -w better-sqlite3,sharp`。

### 打包注意事项

- Native 模块通过 asar `unpackDir` 排除：`node_modules/{sharp,better-sqlite3,@lancedb,@img,node-*}`
- AI Worker 脚本作为 `extraResource` 打包（`models/`、`scripts/embed-worker.mjs`、`scripts/face-worker.mjs`）
- 打包工具：Electron Forge + Squirrel (Windows)

---

## 常用命令

```bash
npm run dev           # 启动开发模式（Vite HMR + Electron）
npm run make          # 打包 Windows 安装包
npm run test          # 运行 Vitest 单元测试
npm run test:watch    # Vitest watch 模式
npx vitest run src/tests/unit/foo.test.ts  # 运行单个测试文件
npm run test:e2e      # 运行 Playwright 端到端测试
npm run check         # Biome lint 检查（通过 ultracite 封装）
npm run fix           # Biome 自动修复（ultracite fix）
npx tsc --noEmit      # 类型检查（忽略 node_modules 中的错误，只看 src/ 开头的输出）
npm run db:generate   # 生成 Drizzle 迁移文件
npm run db:migrate    # 执行数据库迁移
npx shadcn add <comp> # 添加 shadcn/ui 组件
```

**注意**: `npx tsc --noEmit` 会输出 node_modules 中第三方库的类型错误（@electron-forge、@orpc 等），这些可以忽略。只关注 `src/` 路径开头的错误。

---

## Git 工作流

**远程仓库**: https://gitee.com/Uyoung_ly/ai-image-manager.git

**核心规则**: 每次修改完成后自动提交并推送。

```bash
# 每次代码修改完成后的标准流程:
git add -A
git commit -m "<type>: <简短描述>"
git push origin main
```

**Commit 类型**:
- `feat`: 新功能
- `fix`: Bug 修复
- `refactor`: 重构
- `style`: UI/样式调整
- `docs`: 文档更新
- `chore`: 工程/配置变更
- `perf`: 性能优化

**注意**:
- 不要推送 `node_modules/`、`data/`、`.vite/`、`out/`（已在 .gitignore）
- 不要在 commit message 中写 `Co-Authored-By`（除非用户明确要求）

---

## 前端模式备忘

### 本地图片 URL

渲染进程通过自定义协议 `local-media://` 加载本地图片（Electron 注册的 protocol handler）。**不要使用 `file://`**。

```typescript
function toLocalMediaUrl(filePath: string | null | undefined): string {
  if (!filePath) return "";
  const encoded = filePath
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `local-media://${encoded}`;
}
```

此函数在 `PhotoCard` 等组件中定义。新组件需要显示图片时，复用此模式。

### TanStack Query 缓存

- 照片列表 query key: `["photos", { folderId, tagId, favoriteOnly, sort, order }]`
- 文件夹列表: `["folders"]`
- 标签列表: `["tags"]`
- AI 状态: `["aiStatus"]`
- `queryClient` 从 `@/providers/QueryProvider` 导出
- 修改数据后必须 invalidate 相关缓存：`queryClient.invalidateQueries({ queryKey: ["photos"] })`
- 默认 staleTime 30s，refetchOnWindowFocus 关闭

### 路由树自动生成

`src/routeTree.gen.ts` 由 TanStack Router Vite 插件在 `npm run dev` 时自动生成。新增 `src/routes/*.tsx` 文件后启动 dev server 即可自动更新路由树，无需手动编辑。

### IME 输入处理

中文输入法（IME）在组合过程中会触发 `keydown` 事件（如 Enter 确认候选词）。所有带 `onKeyDown` 快捷键的 `<input>` 必须使用 composition guard：

```typescript
const composingRef = useRef(false);
// ...
<input
  onCompositionStart={() => { composingRef.current = true; }}
  onCompositionEnd={(e) => { composingRef.current = false; setVal((e.target as HTMLInputElement).value); }}
  onKeyDown={(e) => {
    if (composingRef.current) return;
    if (e.key === "Enter") handleSave();
  }}
/>
```

### 照片网格与灯箱

- `PhotoGrid`：瀑布流布局，通过 `data-photo-id` / `data-photo-path` 属性支持右键菜单事件委托
- `PhotoLightbox`：全屏查看器，需要 `{ id, filename, path, width, height }` 格式的 photos 数组

### 软删除模式

照片删除使用软删除（`photos.deletedAt` 字段）：
- `deletePhoto`/`deletePhotos` 设置 `deletedAt = Date.now()`，不移动文件
- `listPhotos` 自动过滤 `deletedAt IS NOT NULL` 的记录
- `restorePhotos` 将 `deletedAt` 置为 `null`
- `permanentlyDeletePhotos`/`emptyTrash` 才真正移动文件到系统回收站并删除数据库记录
- 恢复/永久删除后需 invalidate `["photos"]` 和 `["folders"]` 缓存

---

## 测试模式

- 纯函数从 service 模块提取后独立测试（避免 Electron/native 模块依赖）
- 组件测试使用 `@testing-library/react` + `@testing-library/user-event`
- 集成测试通过 `vi.mock("electron")` 和 `vi.mock("electron-store")` 隔离 Electron 环境
- 需要 Node.js API 的测试文件顶部加 `// @vitest-environment node`
- 测试描述使用中文

---

## 业务约束

1. **不修改原始文件**: 索引是只读的，除非用户主动执行移动/删除/重命名
2. **隐私优先**: AI 推理 100% 本地（ONNX Runtime），不上传任何图片到云端
3. **渐进式功能**: AI 功能是增值的，核心浏览/搜索在 AI 未就绪时仍可用
4. **文件夹就地索引**: 不复制原始文件，不创建专有数据库格式
5. **错误静默降级**: AI 模块加载失败不影响核心浏览功能

---

## 关键参考文件

| 文件 | 内容 |
|------|------|
| `DESIGN.md` | Linear 设计系统完整规范（色彩/字体/组件/间距/Do&Don't） |
| `PDR.md` | 产品设计需求文档（市场分析/竞品/功能矩阵/路线图） |
| `reusable-tech-report.md` | 可复用技术选型报告（库对比/复用度估算） |
| `drizzle.config.ts` | Drizzle Kit 配置 |
| `forge.config.ts` | Electron Forge 打包配置 |
