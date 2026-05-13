# CLAUDE.md — AI Image Manager

> 本地 AI 图片管理器：Electron + React + TypeScript
> 项目启动：2026-05-09
> 版本：v0.2.0 — AI 核心就绪

---

## 项目概述

一款 Windows 桌面应用，提供本地 AI 图片浏览、搜索和管理能力。
- 双击 exe 即用，100% 本地处理，零数据上传
- **CLIP 语义搜索已打通**：自然语言搜索（中/英），延迟 <50ms（PDR 目标 <500ms）
- EXIF 仪表盘可视化拍摄习惯
- 参考设计系统：Linear Dark（来自 awesome-design-md）

### v0.2 AI 核心能力

| 能力 | 状态 | 指标 |
|------|------|------|
| CLIP ViT-B/32 模型加载 | ✅ | 文本模型 ~0.6s, 视觉模型 ~1.2s |
| 文本嵌入 (搜索Query) | ✅ | avg 7ms/query |
| 图像 CLIP 嵌入 | ✅ | avg 33ms/张 (PDR <100ms) |
| LanceDB 向量存储 | ✅ | IVF_PQ 索引, cosine 距离 |
| 自然语言搜索 | ✅ | avg 12ms (PDR <500ms, 超额42倍) |
| 以图搜图 | ✅ | Worker 子进程 |
| 智能去重 | ✅ | pHash 筛查 + CLIP 精排 |
| AI 自动标签 | ✅ | 零样本分类, 46个候选标签 |

> **已知限制**: ONNX WASM 后端与 sharp/libvips 共享 GLib, 在同一进程中加载会冲突。生产代码通过进程隔离 (Worker) 和渐进式批次拆分处理。测试中通过手工构建 Tensor 绕过。

---

## 技术栈

| 层 | 技术 | 版本 |
|----|------|------|
| 桌面壳 | Electron | 41.x |
| 前端框架 | React | 19.2 |
| 语言 | TypeScript | 6.x (strict) |
| 构建 | Vite | 8.x |
| 打包 | electron-forge | 7.11 |
| CSS | Tailwind CSS | 4.x |
| UI 组件 | shadcn/ui + Radix UI | latest |
| 路由 | TanStack Router | 1.x (文件路由) |
| 数据获取 | TanStack Query | 5.x |
| IPC | oRPC | 1.x (类型安全) |
| 国际化 | i18next | 26.x |
| 数据库 | better-sqlite3 + Drizzle ORM | 12.x / 0.44 |
| 图片处理 | sharp | 0.34 |
| EXIF | exifr | 7.x |
| AI 推理 | Transformers.js (ONNX) | 2.x |
| 向量存储 | LanceDB | 0.18 |
| 文件监听 | chokidar | 5.x (ESM) |
| 图片去重 | @claudiu-ceia/dhash | latest |
| 缓存 | lru-cache | 11.x |
| 图表 | recharts | 2.x |
| 虚拟滚动 | react-virtuoso | 4.x |
| 灯箱 | yet-another-react-lightbox | 3.x |
| 测试 | Vitest + Playwright | 4.x / 1.x |
| Lint/Format | Biome | 2.x |

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
│   ├── app.ts                 # 应用信息
│   ├── language.ts            # 语言切换
│   ├── shell.ts               # Shell 操作
│   ├── theme.ts               # 主题切换
│   └── window.ts              # 窗口控制
│
├── components/                # React 组件
│   ├── ui/                    # shadcn/ui 组件（复制到项目中）
│   │   ├── button.tsx
│   │   ├── skeleton.tsx
│   │   ├── toggle.tsx
│   │   └── toggle-group.tsx
│   ├── PhotoCard.tsx          # 图片缩略图卡片
│   ├── PhotoGrid.tsx          # 瀑布流网格
│   ├── SearchBar.tsx          # 搜索栏（Ctrl+K 唤起）
│   ├── Sidebar.tsx            # 侧边栏（文件夹树 + 导航）
│   ├── drag-window-region.tsx # 自定义标题栏拖拽区
│   ├── toggle-theme.tsx       # 主题切换按钮
│   └── lang-toggle.tsx        # 语言切换按钮
│
├── routes/                    # TanStack Router 文件路由
│   ├── __root.tsx             # 根路由（BaseLayout 包裹）
│   ├── index.tsx              # 主页：照片浏览 / 搜索
│   ├── dashboard.tsx          # EXIF 仪表盘
│   └── settings.tsx           # 设置页面
│
├── layouts/
│   └── base-layout.tsx        # 基础布局（标题栏 + 内容区）
│
├── ipc/                       # oRPC IPC 层
│   ├── router.ts              # 路由聚合（所有模块注册）
│   ├── handler.ts             # RPCHandler 实例
│   ├── manager.ts             # 渲染进程 IPC 客户端
│   ├── context.ts             # IPC 上下文（主窗口引用）
│   ├── app/                   # 应用信息模块
│   ├── shell/                 # Shell 操作模块
│   ├── theme/                 # 主题模块
│   ├── window/                # 窗口控制模块
│   └── photos/                # 照片管理模块（核心业务）
│       ├── index.ts           # 导出全部 handler
│       └── handlers.ts        # 照片 CRUD + 搜索 + AI 处理器
│
├── db/                        # 数据库层
│   ├── schema.ts              # Drizzle ORM Schema（8 张表）
│   └── index.ts               # 数据库初始化 + 连接管理
│
├── services/                  # 核心服务（仅在主进程运行）
│   ├── indexer.ts             # 索引引擎（扫描 + EXIF + 监听）
│   ├── thumbnailer.ts         # 缩略图服务（三级缓存）
│   └── ai-embedder.ts         # AI 嵌入服务（CLIP + LanceDB）
│
├── constants/
│   └── index.ts               # IPC 频道 + 环境变量 + 本地存储键
│
├── localization/              # i18next 国际化
│   ├── i18n.ts
│   ├── langs.ts
│   └── language.ts
│
├── styles/
│   └── global.css             # Tailwind v4 + Linear 主题变量
│
├── types/
│   └── theme-mode.ts
│
├── utils/
│   ├── path.ts                # 基础路径工具
│   ├── routes.ts              # TanStack Router 工具
│   └── tailwind.ts            # Tailwind 工具（cn）
│
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

Renderer Process（渲染进程）
  ├── React 19 + TanStack Router
  ├── shadcn/ui 组件
  ├── IPC Client：oRPC Client（类型安全调用主进程）
  └── 状态管理：TanStack Query + React state
```

### 主进程构建（Vite ESM 输出）

主进程通过 Vite 构建，输出格式为 **ESM**（`formats: ["es"]`）。ESM 环境中 **没有 `require()` 函数**。

**关键规则：在 `src/main.ts` 或主进程代码中新增 npm 依赖时，必须将其加入 `vite.main.config.mts` 的 `rollupOptions.external` 列表。**

原因：如果一个 CJS 包（内部使用 `require()`）被 Vite 打包进 ESM 输出，运行时会报错 `Calling 'require' for "node:xxx" in an environment that doesn't expose the 'require' function`。将其标记为 external 后，Electron 运行时直接从 node_modules 加载，避免此问题。

历史案例：`archiver`、`update-electron-app` 都因此报错过。

### IPC 通信模式

本项目使用 **oRPC** 而非传统的 `ipcRenderer.invoke`。

**主进程注册 handler**（`src/ipc/photos/handlers.ts`）:
```typescript
export const listPhotos = os.handler(async ({ input }) => {
  const db = getDatabase();
  const items = db.select().from(photos).all();
  return { items };
}).input(z.object({ folderId: z.number().optional() }));
```

**渲染进程调用**:
```typescript
import { ipc } from "@/ipc/manager";
const result = await ipc.client.photos.listPhotos({ folderId: 1 });
```

**规则**:
- Handler 必须使用 Zod schema 验证输入
- 所有数据库访问必须在主进程（handler 内）
- 渲染进程不得直接引入 `better-sqlite3`、`sharp`、`chokidar` 等 Node.js 模块
- 新模块在 `src/ipc/<模块名>/` 下创建，然后在 `router.ts` 注册

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

---

## 常用命令

```bash
npm run dev           # 启动开发模式（Vite HMR + Electron）
npm run make          # 打包 Windows 安装包
npm run test          # 运行 Vitest 单元测试
npm run test:e2e      # 运行 Playwright 端到端测试
npm run check         # Biome lint 检查
npm run fix           # Biome 自动修复
npm run db:generate   # 生成 Drizzle 迁移文件
npm run db:migrate    # 执行数据库迁移
npx shadcn add <comp> # 添加 shadcn/ui 组件
```

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
