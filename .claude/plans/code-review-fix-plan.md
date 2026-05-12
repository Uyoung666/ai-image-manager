# AI Image Manager — 代码审查修复计划

> 创建日期: 2026-05-12
> 基于: 全项目代码审查 (对照 DESIGN.md / PDR.md / reusable-tech-report.md)
> 状态: 已完成 (2026-05-12)

---

## 计划总览

本计划基于对 17 个核心文件（~5500 行逻辑代码）的完整审查，针对 9 个黑盒测试缺陷和发现的架构/性能/设计问题，按优先级分四个阶段修复。

| 阶段 | 工期 | 目标 |
|------|------|------|
| P0 — 阻塞修复 | 3-5 天 | 核心功能可用：搜索、以图搜图、瀑布流、标签 |
| P1 — UX 修复 | 1 周 | 重命名/转换/导出/标签栏正常可用 |
| P2 — 功能完善 | 2 周 | 仪表盘完整、搜索体验、设计规范对齐 |
| P3 — 架构优化 | 1 月 | Worker Pool、类型安全、100K 压测 |

---

## P0 — 阻塞修复（核心功能不可用的 5 个缺陷）

### P0-1: 修复自然语言搜索 + 以图搜图完全不可用

**当前状态**: 搜索返回空数组，用户看不到任何结果和任何错误提示。

**根因链**:
1. 模型加载、向量库初始化、embedAllPhotos 三个环节各自独立，没有就绪信号
2. 任何一个环节失败，后续全部静默返回 `[]`
3. 前端不区分"AI 未就绪"和"无匹配结果"

**修复方案**:

1. **后端** (`src/services/ai-embedder.ts`):
   - 添加 `getAiReadiness(): { model: boolean, vectorDB: boolean, hasVectors: boolean, indexReady: boolean }` 
   - `searchByText` / `searchByImage` 函数抛出可区分的错误类型（NOT_READY / NO_RESULTS / MODEL_ERROR 等）
   - 确保 `initVectorDB()` 在 `loadModel()` 之前被调用时不会静默失败

2. **IPC 层** (`src/ipc/photos/handlers.ts`):
   - `searchByText` handler 捕获并返回结构化错误：`{ results, error?, diagnostic? }`
   - 添加 `getAiStatus` handler 暴露就绪状态给前端

3. **前端** (`src/routes/index.tsx`):
   - 搜索前检查 AI 状态，若未就绪显示明确提示（"AI 模型加载中..." / "向量索引构建中..."）
   - `SearchBar` 的 placeholder 根据状态动态变化

**涉及文件**:
- `src/services/ai-embedder.ts` — 添加就绪检查
- `src/ipc/photos/handlers.ts` — 结构化错误返回
- `src/routes/index.tsx` — 前端状态感知
- `src/components/SearchBar.tsx` — 动态 placeholder

---

### P0-2: 修复瀑布流中间空隙

**当前状态**: 同一行内不同列图片高度不一，导致横向图下方大面积空白。

**根因**: `PhotoGrid.tsx` 使用行对齐方案（`buildRows()` 把所有列对齐成等长行），违背了瀑布流"每列独立高度"的核心原理。

**修复方案**: 用 `react-virtuoso` 的 `VirtuosoMasonry` 组件重写瀑布流。

具体步骤：
1. 移除 `distributePhotos()` + `buildRows()` + `defaultItemHeight` 逻辑
2. 将 `photos` 传入 `VirtuosoMasonry`，由组件内部管理列分配
3. 保留 `PhotoCard` 组件不变
4. 保留密度切换工具栏（小/中/大）
5. `computeItemKey` 改用 `photo.id` 而非 index，修复重排序 DOM 混乱

伪代码：
```tsx
<VirtuosoMasonry
  items={photos}
  itemContent={(index, photo) => (
    <PhotoCard key={photo.id} ... />
  )}
  computeItemKey={(_, photo) => photo.id}
/>
```

**涉及文件**:
- `src/components/PhotoGrid.tsx` — 主要改动

---

### P0-3: 修复 AI 索引性能（500 张 4 分钟 → 目标 40-60 秒）

**当前状态**: 每 20 张 fork 一个新进程，每个进程重新加载 ~87MB CLIP 模型。

**根因**: Worker 模型加载发生在每个批次的进程内部（`embed-worker.mjs:134`），进程处理完即退出，模型无法复用。

**修复方案**: 建立长期运行的 Worker Pool。

1. 新增 `src/services/embed-worker-pool.ts`:
   - 启动 N 个常驻 worker（N = CPU 核心数 - 1，最少 2）
   - 每个 worker 启动时加载模型一次
   - 通过 IPC 消息分发嵌入任务（不退出进程）
   - 使用 `p-queue`（已安装）控制并发

2. 修改 `embed-worker.mjs`:
   - 不再在 `process.on("message")` 回调中 `process.exit(0)`
   - 改为处理完一批后继续等待下一条消息
   - 新增 `shutdown` 消息类型用于优雅退出

3. 修改 `ai-embedder.ts`:
   - `embedAllPhotos` 使用 Worker Pool 而非每次 fork
   - 移除 `runEmbedBatch` 中的 fork/exit 模式
   - 调整 `BATCH_SIZE` 为每个 worker 每次处理 10-15 张

**涉及文件**:
- `scripts/embed-worker.mjs` — 改为常驻模式
- `src/services/ai-embedder.ts` — Worker Pool 调度
- 新增 `src/services/embed-worker-pool.ts` — Pool 管理器

---

### P0-4: 修复 AI 标签全部识别为"户外/城市/室内"

**当前状态**: 所有照片获得相同的三个场景标签。

**根因（双层）**:
1. `runAutoTagSuggestions()` 在 `scanFolder()` 完成时调用（fire-and-forget），此时照片还没有 CLIP 向量，`suggestTags()` 只能走昂贵的单图 Worker 嵌入
2. 场景类标签（indoor/outdoor/city）在 CLIP 语义空间中天然比其他具体标签有更高的余弦相似度，阈值 0.25 太低

**修复方案**:

1. **时序修复** (`src/services/indexer.ts`):
   - 移除 `scanFolder()` 末尾的 `runAutoTagSuggestions()` 调用
   - 改为在 `embedAllPhotos()` 完成后批量触发 auto-tagging，此时所有向量已在 LanceDB 中

2. **阈值修复** (`src/services/ai-embedder.ts`):
   - 引入标签分类权重：场景标签 (indoor/outdoor/city/nature/beach/mountain/forest/street/sky/night) 阈值 ×1.5
   - 每张照片最多自动确认 5 个标签（按 confidence 排序取 top-5）
   - 默认阈值从 0.25 提高到 0.30

3. **批量优化**:
   - `runAutoTagSuggestions` 改用 `getPhotoVectors()` 批量从 LanceDB 读取向量（而非单张 Worker 嵌入）
   - 一次读取所有需处理的照片向量，内存中批量计算标签相似度

**涉及文件**:
- `src/services/indexer.ts` — 移除过早的 auto-tag 调用
- `src/services/ai-embedder.ts` — 阈值分层 + 批量模式 + embedAllPhotos 后触发

---

### P0-5: 修复点击标签崩溃 "Cannot read properties of undefined (reading 'replace')"

**根因**: 两种可能：
1. `listPhotos` 的 `innerJoin(photoTags)` 导致 better-sqlite3 返回的行对象中 `path` 字段被 photo_tags 表的同名字段覆盖
2. `Sidebar` 标签点击 → `loadPhotos` 异步更新期间，旧 photos 数组与新 selectedIds 不匹配

**修复方案**:

1. **handler 层防御** (`src/ipc/photos/handlers.ts`):
   - `listPhotos` 的 tagId 筛选改用子查询而非 innerJoin：
     ```typescript
     if (tagId) {
       query = query.where(
         sql`${photos.id} IN (SELECT photo_id FROM photo_tags WHERE tag_id = ${tagId})`
       );
     }
     ```
   - 避免 innerJoin 污染返回列

2. **前端防御** (`src/components/PhotoCard.tsx`):
   - `toLocalMediaUrl` 入参加空值检查：`if (!filePath) return ""`

3. **PhotoGrid key 修复**:
   - `computeItemKey` 从 `(index) => index` 改为 `(_, photo) => photo?.id ?? index`

**涉及文件**:
- `src/ipc/photos/handlers.ts` — innerJoin → 子查询
- `src/components/PhotoCard.tsx` — 空值防御
- `src/components/PhotoGrid.tsx` — key 修复

---

## P1 — UX 修复（影响日常使用的 4 个缺陷）

### P1-6: 修复重命名后图片不显示

**问题**: `renamePhotos` 更新了 DB 中的 `thumbnailPath` 为新路径的 MD5 哈希，但没有实际生成缩略图文件。

**修复方案** (`src/ipc/photos/handlers.ts`):
1. 重命名后，检查旧 thumbnailPath 对应的文件是否存在
2. 若存在，将旧缩略图文件重命名为新 MD5 路径
3. 若不存在，异步调用 `generateThumbnail()` 生成新缩略图
4. 重命名完成后，立即 `loadPhotos()` 刷新前端

**涉及文件**:
- `src/ipc/photos/handlers.ts` — renamePhotos handler
- `src/services/thumbnailer.ts` — 可能需要添加 `moveThumbnail` 辅助函数

---

### P1-7: 修复格式转换不能选择输出路径

**问题**: `FormatConvertDialog` 始终传 `outputDir: ""`，后端 fallback 到 `%TEMP%/convert-xxx`。

**修复方案**:
1. `FormatConvertDialog.tsx` 添加"选择输出目录"按钮
2. 调用 `ipc.client.shell.openFolderDialog()` 获取用户选择的路径
3. `handlers.ts` 保留 temp 回退作为默认值

**涉及文件**:
- `src/components/FormatConvertDialog.tsx` — 添加文件夹选择 UI
- `src/ipc/photos/handlers.ts` — 移除 temp 回退（当 outputDir 为空时先要求前端传值）

---

### P1-8: 修复导出 ZIP 空文件 + "createArchive is not a function"

**问题**: `archiver` v8.0.0 ESM-only 在 Electron 动态 import 下导出结构不兼容。

**修复方案**:
1. 将 `archiver` 降级到 v7.x（支持 CJS），或替换为 `adm-zip`（CJS 原生支持）
2. 将 `fs.createWriteStream(zipPath)` 移到 `createArchive` 成功调用之后，避免先创建空文件
3. 添加 try-catch 在 archiver 初始化失败时删除已创建的空文件

**涉及文件**:
- `package.json` — 降级 archiver 或替换
- `src/ipc/photos/handlers.ts` — exportPhotos handler（ZIP 创建逻辑）

---

### P1-9: 修复导入第一个文件夹时不显示标签栏

**问题**: `runAutoTagSuggestions` 是 fire-and-forget，在 `scanFolder` 返回后才跑完，但 `loadPhotos` 已先刷新。

**修复方案** (配合 P0-4 的时序修复):
1. Auto-tagging 移到 `embedAllPhotos` 完成后触发（见 P0-4）
2. `Sidebar` 的标签加载加一个轮询或事件驱动机制：
   - 方案 A：暴露 IPC `onTagsChanged` 事件，主进程在标签变更时推送
   - 方案 B：`Sidebar` 每隔 3 秒自动刷新标签列表（仅在 totalPhotos > 0 且 tags.length === 0 时）

推荐方案 A（更精准）。

**涉及文件**:
- `src/components/Sidebar.tsx` — 事件驱动刷新
- `src/ipc/photos/handlers.ts` — 可能需要新增事件通知机制
- `src/main.ts` — 或通过 webContents.send 推送

---

## P2 — 功能完善（两周内）

### P2-10: 完善 EXIF 仪表盘

对标 PDR §8.3 仪表盘设计，当前缺少：
- 镜头使用频率分布（只有相机统计）
- 拍摄时间热力图只有 4 个粗时段（应有 24 小时分布）
- 无地理位置地图
- 无颜色分布统计

**涉及文件**:
- `src/ipc/photos/handlers.ts` — getStats handler 查询扩展
- `src/routes/dashboard.tsx` — 图表组件扩展

### P2-11: 修复设计系统违规

对照 DESIGN.md：
- 统一字重：全文搜索 `font-bold` → 替换为 `font-[590]`
- 统一圆角：全文搜索 `rounded-` → 统一为 4/6/8/12/full 五档
- 统一颜色：全文搜索硬编码色值 → 替换为 CSS 变量引用
- 统一 input/button 样式为 DESIGN.md §4 规范

**涉及文件**:
- `src/styles/global.css` — 确保 CSS 变量完整
- 全局搜索替换（~10 个文件）

### P2-12: 搜索体验优化

- 搜索无结果时区分"AI 未就绪"、"向量索引为空"、"无匹配图片"
- 显示搜索耗时和结果数量
- 以图搜图结果展示相似度百分比
- AI 索引进度实时展示在搜索栏旁边

**涉及文件**:
- `src/components/SearchBar.tsx` — 状态展示
- `src/components/AiProgressBar.tsx` — 改进进度展示

### P2-13: 路径遍历安全漏洞修复

`local-media://` 协议处理 (`main.ts:344-359`) 没有校验请求的文件路径是否在允许的范围内。

**修复方案**:
1. 从请求的 `filePath` 中解析出实际路径
2. 检查是否在已索引的文件夹路径列表中
3. 不在白名单内的路径返回 403

**涉及文件**:
- `src/main.ts` — protocol handler

---

## P3 — 架构优化（一个月内）

### P3-14: ServiceRegistry 统一生命周期管理

```typescript
// src/services/registry.ts
class ServiceRegistry {
  async start(): Promise<HealthReport> {
    // L1: Database (阻塞)
    // L2: Thumbnailer (阻塞)
    // L3: FileWatcher (后台)
    // L4: AI Service (后台, 可降级)
  }
  health(): HealthReport { ... }
}
```

### P3-15: IPC 类型安全去 `any` 化

全项目搜索 `as any` 并逐一替换为正确的 oRPC 类型推导。

### P3-16: 100K+ 图片性能压测

- 使用脚本生成 100K 测试图片
- 测试虚拟滚动帧率
- 测试搜索延迟（PDR 目标 <500ms）
- 测试内存占用（PDR 目标 <120MB）

---

## 实施顺序

```
P0-1 (AI 搜索可用) ──→ P0-5 (标签崩溃) ──→ P0-4 (标签偏置)
         ↓                    ↓
P0-3 (Worker Pool)    P0-2 (瀑布流重写)
         ↓
P1-9 (标签栏刷新) ←── P1-6 (重命名) ←── P1-7 (格式转换) ←── P1-8 (导出)
         ↓
      P2 (功能完善, 3-4 天)
         ↓
      P3 (架构优化, 持续)
```

P0-1 是所有 AI 功能的基础，必须最先修复。P0-3 和 P0-2 可并行推进。

---

## 涉及文件总览

| 文件 | P0 | P1 | P2 | P3 |
|------|:--:|:--:|:--:|:--:|
| `src/services/ai-embedder.ts` | ✅ | | | |
| `scripts/embed-worker.mjs` | ✅ | | | |
| `src/ipc/photos/handlers.ts` | ✅ | ✅ | ✅ | |
| `src/routes/index.tsx` | ✅ | | | |
| `src/components/PhotoGrid.tsx` | ✅ | | | |
| `src/components/PhotoCard.tsx` | ✅ | | | |
| `src/components/SearchBar.tsx` | ✅ | | ✅ | |
| `src/components/Sidebar.tsx` | ✅ | ✅ | | |
| `src/services/indexer.ts` | ✅ | | | |
| `src/components/FormatConvertDialog.tsx` | | ✅ | | |
| `src/main.ts` | | | ✅ | |
| `src/styles/global.css` | | | ✅ | |
| `package.json` | | ✅ | | |
| 新增 `src/services/embed-worker-pool.ts` | ✅ | | | |
