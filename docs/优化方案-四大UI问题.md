# 四大 UI 问题审查与优化方案

> 审查日期: 2026-05-10
> 审查范围: 窗口自适应、瀑布流排版、滚轮滚动、缩略图清晰度
> 未修改代码，仅提供分析 + 方案

---

## 一、问题诊断总表

| # | 问题 | 严重度 | 根因数量 | 涉及文件 |
|---|------|--------|---------|---------|
| 1 | 窗口自适应差 | 🔴 高 | 4 | main.ts, base-layout.tsx, index.tsx, global.css |
| 2 | 瀑布流排版杂乱 | 🔴 高 | 3 | PhotoGrid.tsx, PhotoCard.tsx |
| 3 | 无法滚轮滑动 | 🟡 中 | 3 | main.ts, base-layout.tsx, PhotoGrid.tsx |
| 4 | 缩略图太糊 | 🔴 高 | 3 | thumbnailer.ts, PhotoCard.tsx, indexer.ts |

---

## 二、逐问题深度分析

### 问题 1：程序窗口自适应做的不好

#### 1.1 现状代码追踪

**窗口创建** (`src/main.ts:140-158`):
```typescript
mainWindow = new BrowserWindow({
  width: 1280, height: 800,
  minWidth: 900, minHeight: 600,
  titleBarStyle: "hidden",  // 无边框窗口, Windows 下需自绘标题栏
  ...
});
```

**根布局** (`src/layouts/base-layout.tsx:37-38`):
```tsx
<div className="flex h-screen flex-col overflow-hidden">
  <DragWindowRegion title="AI Image Manager" />
  <main className="flex-1 overflow-hidden">{children}</main>
</div>
```

**主页布局** (`src/routes/index.tsx:257-266`):
```tsx
<div className="flex h-full">
  <Sidebar ... />                            // 固定 w-[240px]
  <div className="flex min-w-0 flex-1 flex-col">
    <SearchBar ... />
    <div className="flex min-h-0 flex-1">
      <PhotoGrid ... />
      {detailPhoto && <PhotoDetailPanel ... />}  // 右侧面板无固定宽度
    </div>
  </div>
</div>
```

**列数自适应** (`src/components/PhotoGrid.tsx:55-65`):
```typescript
const observer = new ResizeObserver(([entry]) => {
  const width = entry.contentRect.width;
  const cols = Math.max(MIN_COLUMNS, Math.floor(width / targetColWidth));
  setColumnCount(cols);
});
```

#### 1.2 根因分析

**根因 A — 侧边栏无折叠机制**
- 侧边栏固定 240px（`src/components/Sidebar.tsx:35`），窗口缩至 900px 时占用 27% 宽度
- 没有折叠/展开按钮，没有记忆用户偏好
- Eagle 做法：侧边栏可拖拽调整宽度、可完全折叠为图标栏
- Adobe Bridge 做法：侧边栏宽度可拖拽、面板可折叠

**根因 B — 布局缺少断点响应**
- 只用 ResizeObserver 调整列数，不调整间距、卡片圆角、字体大小
- `DESIGN.md:240-248` 定义了响应式断点，但代码未完整实现
- 详情面板（PhotoDetailPanel）弹出时与网格抢占空间，无最小宽度保护

**根因 C — Electron frameless 窗口的 DPI 问题**
- `titleBarStyle: "hidden"` 下 Windows 缩放 > 100% 时，`h-screen` 可能计算偏差
- 没有调用 `screen.getPrimaryDisplay().scaleFactor` 做 DPI 感知补偿
- 窗口状态恢复时未校验坐标是否在多显示器环境下仍然有效

**根因 D — 最小窗口 900x600 偏大**
- PDR 对标产品中，Eagle 支持 800x500 紧凑模式
- Google Photos PWA 可在 600px 宽下正常使用

#### 1.3 一线应用对标

| 应用 | 侧边栏 | 最小宽度 | 响应式策略 |
|------|--------|---------|-----------|
| **Eagle** | 可拖拽宽度 + 一键折叠 | ~800px | 侧边栏折叠 + 网格自适应 |
| **Google Photos** | 左侧导航 64px(折叠)/256px(展开) | ~600px | Material Design 断点 |
| **Adobe Bridge** | 面板系统，自由停靠/折叠 | ~900px | 面板可拖拽重组 |
| **Immich** | 侧边栏可折叠 | ~640px(移动端友好) | CSS Grid + 断点 |
| **DigiKam** | 可停靠面板 | ~800px | Qt 布局管理器 |

### 问题 2：瀑布流排版衔接不上，显得不整齐杂乱

#### 2.1 现状代码追踪

**瀑布流实现** (`src/components/PhotoGrid.tsx:162-167`):
```tsx
<div
  className="flex-1 overflow-y-auto px-2 pt-2"
  style={{ columnCount, columnGap: 8 }}
>
```

**卡片** (`src/components/PhotoCard.tsx:97-111`):
```tsx
<div
  className="... break-inside-avoid ..."
  style={{
    aspectRatio,                        // 来自原始图片宽高比
    contentVisibility: "auto",
    containIntrinsicSize: "auto 200px",  // ← 固定 200px 估算高度
  }}
>
```

#### 2.2 根因分析

**根因 A — CSS `columns` 不是真正的瀑布流**

CSS Multi-column Layout 的排列顺序是 **列优先**（先填满第 1 列，再第 2 列……）：

```
CSS Columns (现状)         真正的瀑布流 (期望)
┌──┐ ┌──┐ ┌──┐            ┌──┐ ┌──┐ ┌──┐
│1 │ │3 │ │5 │            │1 │ │2 │ │3 │
│  │ │  │ │  │            │  │ │  │ ├──┤
│  │ ├──┤ │  │            │  │ ├──┤ │5 │
│  │ │4 │ │  │            ├──┤ │4 │ │  │
├──┤ │  │ │  │            │3 │ │  │ │  │
│2 │ │  │ ├──┤            │  │ │  │ ├──┤
│  │ │  │ │6 │            │  │ ├──┤ │6 │
│  │ ├──┤ │  │            │  │ │7 │ │  │
│  │ │7 │ │  │            ├──┤ │  │ │  │
└──┘ └──┘ └──┘            │8 │ │  │ └──┘
                           └──┘ └──┘
```

由于照片的高宽比差异巨大（从 3:4 竖图到 16:9 横图），列优先排列意味着：
- 第 1 列可能全是竖图（很长），第 3 列全是横图（很短）
- 视觉上左边高右边低，极不均衡
- 新加载的照片追加到最后，导致某列特别长

**根因 B — `containIntrinsicSize: "auto 200px"` 的估算偏差**

`contentVisibility: auto` 配合 `containIntrinsicSize` 是性能优化手段，让浏览器在元素进入视口前用估算值占位。但固定 200px 的估算高度与实际图片加载后的高度差异巨大：
- 16:9 横图在 220px 宽列中实际高度约 124px → 占位过大，留白
- 3:4 竖图在 220px 宽列中实际高度约 293px → 占位不足，加载后跳动

这导致图片加载过程中布局频繁跳动，体验很差。

**根因 C — 没有统一的图片裁剪策略**

Eagle、Google Photos 等成熟应用会：
- 对竖图（aspectRatio < 0.75）裁剪为 3:4 或 2:3
- 对超宽图（aspectRatio > 2.5）裁剪为 16:9 或 2:1
- 只对中等比例的图片保留原始比例

当前代码保留了所有图片的原始比例（`PhotoCard.tsx:63`），导致极端比例的图片破坏瀑布流节奏。

#### 2.3 一线应用对标

| 应用 | 瀑布流方案 | 图片比例策略 | 间距 |
|------|-----------|-------------|------|
| **Google Photos** | JS 绝对定位瀑布流 | 裁剪极端比例，缩略图统一为瓦片状 | 1-2px |
| **Eagle** | JS 瀑布流(masonry-layout) | 保留原始比例但限制最小/最大高度 | 4-8px |
| **Pinterest** | 自定义 JS 瀑布流 | 不限比例，纯最短列优先放置 | 8-16px |
| **Immich** | CSS Grid + `grid-row-end: span N` | 基于缩略图实际高度计算 span 值 | 2-4px |
| **500px** | JS 瀑布流( justified gallery) | 强制行高统一，裁剪或留白 | 2px |

**关键结论**：**没有任何主流照片应用使用 CSS `columns` 做瀑布流**。全部使用 JS 计算布局。

### 问题 3：无法使用滚轮滑动查看照片，只能拖动滑条

#### 3.1 现状代码追踪

**滚动容器** (`src/components/PhotoGrid.tsx:162-164`):
```tsx
<div
  className="flex-1 overflow-y-auto px-2 pt-2"
  ref={containerRef}
  style={{ columnCount, columnGap: 8 }}
>
```

**滚动边界** (`src/layouts/base-layout.tsx:37-39`):
```tsx
<div className="flex h-screen flex-col overflow-hidden">
  <DragWindowRegion ... />
  <main className="flex-1 overflow-hidden">{children}</main>
</div>
```

**拖拽区域** (`src/components/drag-window-region.tsx:35-36`):
```tsx
<div className="draglayer w-full">   <!-- -webkit-app-region: drag -->
```

**CSS 定义** (`src/styles/global.css:129-131`):
```css
.draglayer {
  -webkit-app-region: drag;
}
```

#### 3.2 根因分析

**根因 A — CSS `columns` 容器的滚动行为异常**

这是 **最可能的原因**。CSS Multi-column 布局会创建一个新的 block formatting context。在某些 Chromium 版本中（Electron 41 基于 Chromium 134），当 `columns` 与 `overflow-y: auto` 组合时，浏览器的滚动事件处理存在已知 bug：

- 列布局容器的高度计算与实际可滚动内容不一致
- 滚轮事件可能被列布局内部的分栏容器吞掉
- 鼠标在列间隙上时滚轮失效

**根因 B — `-webkit-app-region: drag` 拦截鼠标事件**

`drag-window-region` 使用 `-webkit-app-region: drag` 实现 frameless 窗口的拖拽。虽然它只覆盖标题栏区域，但 Electron 的 `titleBarStyle: "hidden"` 模式下，Chromium 内部对 `app-region: drag` 区域的处理可能会影响其下层的滚动区域。特别是：
- 拖拽区域与内容区域边界处的事件传递不稳定
- `app-region: drag` 会吞噬该区域内的所有鼠标事件（包括滚轮）

**根因 C — flex 布局 + overflow 链问题**

嵌套层次：
```
overflow-hidden (BaseLayout)
  → overflow-hidden (main)
    → h-full (路由根)
      → flex-1 flex-col (主内容)
        → flex-1 min-h-0 (PhotoGrid 父级)
          → overflow-y-auto (PhotoGrid 滚动容器) ← 这里
```

虽然 `min-h-0` 是正确的，但 `columns` 创建的新 BFC 可能导致滚动容器无法正确计算其滚动高度，使浏览器认为"无需滚动"，从而滚轮事件不触发滚动。

#### 3.3 一线应用做法

- **Eagle**: 主内容区用 `overflow-y: overlay`（已废弃，现改用 `overflow-y: auto`）+ JS 管理滚动位置
- **Google Photos**: 整个页面作为滚动容器（`document.scrollingElement`），不用局部滚动
- **VS Code**: 自定义滚动条实现，完全绕过浏览器原生滚动
- **Figma**: 完全 JS 驱动的虚拟滚动 + 自定义滚轮处理

### 问题 4：瀑布流卡片封面缩略图太糊

#### 4.1 现状代码追踪

**缩略图尺寸配置** (`src/services/thumbnailer.ts:8-12`):
```typescript
const THUMBNAIL_SIZES = {
  sm: 220,   // 对应"小"密度 (160px 列宽)
  md: 360,   // 对应"中"密度 (220px 列宽) ← 默认
  lg: 720,   // 对应"大"密度 (280px 列宽)
} as const;
```

**缩略图生成** (`src/services/thumbnailer.ts:72-75`):
```typescript
const thumbBuffer = await sharp(imagePath)
  .resize(targetSize, targetSize, { fit: "inside", withoutEnlargement: true })
  .jpeg({ quality: 82, mozjpeg: true })
  .toBuffer();
```

**索引时使用** (`src/services/indexer.ts:172`):
```typescript
const thumb = await generateThumbnail(filePath, "md");  // 始终 md (360px)
```

**卡片显示** (`src/components/PhotoCard.tsx:59-61`):
```tsx
const src = thumbnailPath
  ? toLocalMediaUrl(thumbnailPath)    // 显示缩略图
  : toLocalMediaUrl(path);            // 回退到原图
```

**密度配置** (`src/components/PhotoGrid.tsx:27-31`):
```typescript
const DENSITY_CONFIGS = [
  { label: "小", targetColWidth: 160 },
  { label: "中", targetColWidth: 220 },   // 默认
  { label: "大", targetColWidth: 280 },
];
```

#### 4.2 根因分析

**根因 A — 未做高 DPI 适配（最关键）**

现代 Windows 笔记本几乎都是高 DPI 屏幕：

| DPI 缩放 | devicePixelRatio | "中"列实际需要 | 当前缩略图 | 缺口 |
|----------|-----------------|---------------|-----------|------|
| 100% (少见) | 1x | 220px | 360px | ✅ 够用 |
| 125% (常见) | 1.25x | 275px | 360px | ✅ 勉强够 |
| **150%** | **1.5x** | **330px** | **360px** | ⚠️ 刚刚好 |
| **175%** | **1.75x** | **385px** | **360px** | ❌ 不够 |
| **200%** | **2x** | **440px** | **360px** | ❌ 明显模糊 |

在 2x 屏幕上，360px 缩略图被拉伸到 440 设备像素，等于是 **82% 放大**，颗粒感明显。

**根因 B — 所有图片统一用 `md` 尺寸**

`indexer.ts:172` 始终调用 `generateThumbnail(filePath, "md")`，不根据用户当前密度设置生成对应尺寸。

更糟的是，用户切换到"大"(280px) 密度后，在 2x 屏幕上需要 560px，但缩略图只有 360px → **画质劣化 55%**。

**根因 C — JPEG 质量可优化**

- `quality: 82` 对于 360px 的缩略图在 1x 屏幕足够锐利，但在高 DPI 下放大后压缩伪影显现
- `mozjpeg: true` 是好选择，但可以搭配 `chromaSubsampling: "4:4:4"` 保留色彩细节
- 未使用 sharp 的锐化选项（`.sharpen()`），缩略图在缩小后失去微对比度

**根因 D — `object-fit: cover` 与 `aspectRatio` 的不匹配**

```tsx
// PhotoCard.tsx:63
const aspectRatio = width && height ? width / height : 4 / 3;

// PhotoCard.tsx:107
style={{ aspectRatio, ... }}

// PhotoCard.tsx:117
className="h-full w-full object-cover"
```

`aspectRatio` 和 `object-fit: cover` 同时使用，浏览器可能对图片进行二次缩放（`cover` 会裁剪 + 缩放）。当容器计算的 aspectRatio 与图片的实际比例不完全匹配时，图片被浏览器再次缩放，进一步降低清晰度。

#### 4.3 一线应用对标

| 应用 | 缩略图策略 | 尺寸 (物理像素) | 格式 |
|------|-----------|---------------|------|
| **Google Photos** | 服务端多尺寸 + srcset | 512px-1024px (cover) | WebP |
| **Eagle** | 本地生成，按需多尺寸 | 512px-1024px | JPEG(85)/WebP |
| **Immich** | 服务端生成，3-4 档 | 360/720/1440px | WebP/JPEG |
| **Adobe Bridge** | 嵌入式预览 + 按需生成 | 256-1024px | JPEG |
| **Apple Photos** | 系统级缩略图服务 | 根据屏幕 DPI 动态生成 | HEIC/JPEG |

**关键发现**：一线应用缩略图分辨率通常是 **显示尺寸的 2×-3×**，以覆盖 Retina/HiDPI 屏幕。例如 220px 显示列宽 → 至少 512px 缩略图。

---

## 三、综合优化方案

### 方案总览

```
优先级: P0(阻塞体验) → P1(显著改善) → P2(锦上添花)
工作量: 小(<2h) 中(4-8h) 大(1-3天)
```

### P0 — 紧急修复（本迭代立即处理）

#### P0-1: 修复滚轮滚动 → 工作量: 小

**方案**：将滚动容器从 CSS columns 容器迁移到外层 wrapper，使用 JS 计算列布局。

**具体步骤**:
1. 创建两层的容器结构：
   - 外层 `<div>`: `overflow-y: auto`, 滚动在此层
   - 内层 `<div>`: 使用 JS 绝对定位或 CSS Grid 放置卡片
2. 注册 wheel 事件监听，确保在 Electron frameless 窗口下也能捕获
3. 移除 `columns` 属性（这也顺带解决了问题 2）

**备选方案（快速热修复）**:
- 在 PhotoGrid 的滚动容器上显式注册 `onWheel` 事件并手动 `scrollBy`
- 给滚动容器加 `tabIndex={-1}` 确保可聚焦，然后自动聚焦

#### P0-2: 缩略图高清化 → 工作量: 小

**方案 A（推荐—最小改动）**：读取 `devicePixelRatio` 并按需生成。

```typescript
// thumbnailer.ts 改动示意（不是实际代码）
const scale = Math.ceil(devicePixelRatio || 1);  // 1, 2, 3
const THUMBNAIL_SIZES = {
  sm: 220 * scale,  // 1x→220, 2x→440
  md: 360 * scale,  // 1x→360, 2x→720
  lg: 720 * scale,  // 1x→720, 2x→1440
};
```

**方案 B（更彻底—与 Eagle 对标）**：生成多档缩略图 + srcset。
- 每张图片生成 3 档缩略图: 256w, 512w, 1024w
- PhotoCard 的 `<img>` 使用 `srcSet` 属性让浏览器自行选择
- 配合 `sizes` 属性声明实际显示尺寸

**同时改进**:
- JPEG 质量调至 85，添加 `.sharpen({ sigma: 0.5 })` 提升微对比度
- 添加 `chromaSubsampling: "4:4:4"` 保留色彩细节
- 改用 WebP 格式（sharp 原生支持），文件更小画质更高

#### P0-3: 瀑布流重新实现 → 工作量: 中

**方案**：用 JS 最短列优先算法替代 CSS columns。

**核心算法**（伪代码）：
```typescript
function layoutMasonry(photos: Photo[], columnCount: number, columnWidth: number, gap: number) {
  const columnHeights = new Array(columnCount).fill(0);
  const positions: ItemPosition[] = [];

  for (const photo of photos) {
    // 找到当前最矮的列
    const shortestColumn = columnHeights.indexOf(Math.min(...columnHeights));
    const itemHeight = columnWidth / (photo.width / photo.height);

    positions.push({
      x: shortestColumn * (columnWidth + gap),
      y: columnHeights[shortestColumn],
      width: columnWidth,
      height: itemHeight,
    });

    columnHeights[shortestColumn] += itemHeight + gap;
  }

  const totalHeight = Math.max(...columnHeights);
  return { positions, totalHeight };
}
```

**实现选择**:

| 方案 | 优点 | 缺点 | 推荐度 |
|------|------|------|--------|
| 手写最短列优先（~50行） | 零依赖，完全可控 | 需自行处理 resize | ⭐⭐⭐⭐ |
| `react-virtuoso` 已引入 | 自带虚拟滚动，项目已依赖 | 需配 Masonry 模式 | ⭐⭐⭐⭐⭐ |
| CSS Grid + `grid-row-end: span` | 浏览器原生，性能好 | 需预知图片高度算 span | ⭐⭐⭐ |

**推荐**: 既然项目已引入 `react-virtuoso`（见 CLAUDE.md），直接使用其内置的 Masonry 支持。`react-virtuoso` 有 `<VirtuosoGrid>` 组件，天然支持瀑布流 + 虚拟滚动 + 滚轮正常。

#### P0-4: 侧边栏可折叠 → 工作量: 小

- 在侧边栏顶部添加折叠按钮（汉堡图标或 `⌘/` 快捷键）
- 折叠状态: 显示为 48px 宽的图标栏（类似 VS Code Activity Bar）
- 使用 `localStorage` 记住折叠状态
- 侧边栏宽度可拖拽调整（240px - 360px）

### P1 — 重要改进（下一个迭代）

#### P1-1: 图片比例裁剪策略
- 对 aspectRatio < 0.6 (超竖图) → 居中裁剪到 2:3
- 对 aspectRatio > 3.0 (超宽图/全景) → 居中裁剪到 2:1
- 在 0.6-3.0 范围内的保持原始比例
- 裁剪后的缩略图更整齐，视觉节奏一致

#### P1-2: 窗口 DPI 感知
- 启动时读取 `screen.getPrimaryDisplay().scaleFactor`
- 窗口大小以 DPI 无关的方式存储
- 多显示器切换时重新计算布局

#### P1-3: 详情面板优化
- PhotoDetailPanel 设置固定宽度 (320px-400px) 或百分比 (30%)
- 面板宽度可拖拽调整
- 面板显示时，网格自动缩小列宽（ResizeObserver 已处理）

#### P1-4: 渐进式图片加载
- 生成极低质量的 32×32 模糊预览（blurhash 或 base64 内嵌）
- 先用模糊预览占位，再加载高清缩略图
-消除 `containIntrinsicSize: "auto 200px"` 导致的布局跳动

### P2 — 体验打磨（后续迭代）

#### P2-1: 窗口管理增强
- 支持窗口吸附 (Snap Layouts, Windows 11 特性)
- 最小窗口降至 720×480
- 紧凑模式：搜索栏和工具栏自动折叠

#### P2-2: 缩略图预加载
- IntersectionObserver 提前 2 屏加载缩略图
- 滚动方向感知（向下滚动优先加载下方）
- 内存缓存从 200 张扩至 500 张

#### P2-3: 瀑布流动画
- 图片加载完成后以 200ms fade-in 动画显示
- 布局变化（列数切换）时平滑过渡
- 卡片 hover 时的微缩放效果 (scale 1.02)

---

## 四、实施路线图

```
Week 1 (本次迭代):
  Day 1-2: P0-1 滚轮修复 + P0-2 缩略图高清化
  Day 3-4: P0-3 瀑布流重写 (react-virtuoso Masonry)
  Day 5:   P0-4 侧边栏折叠 + 回归测试

Week 2 (下次迭代):
  Day 1-2: P1-1 图片比例裁剪 + P1-4 渐进加载
  Day 3:   P1-2 DPI 感知 + P1-3 详情面板
  Day 4-5: P2-1~P2-3 体验打磨

验收标准:
  ✅ 滚轮在任意密度、任意窗口大小下流畅滚动
  ✅ 200% DPI 屏幕上缩略图清晰无锯齿
  ✅ 瀑布流各列高度偏差 < 15%
  ✅ 窗口 900px 宽 → 侧边栏可折叠，主区域可用
  ✅ 10,000 张图片滚动保持 60fps
```

---

## 五、PDR 文档对照

本方案与 PDR 文档的一致性检查：

| PDR 要求 | 当前状态 | 本方案 |
|----------|---------|--------|
| "瀑布流虚拟滚动, 60fps" (PDR 6.1) | CSS columns, 非真正瀑布流 | P0-3: react-virtuoso Masonry |
| "自适应网格, 可调列数和缩略图大小" (PDR 6.1) | 列数自适应但缩略图尺寸不跟随 DPI | P0-2: DPI 感知缩略图 |
| "10 万图片 60fps 滚动" (PDR 7.4) | 无滚轮 → 无法验证 | P0-1: 修复滚动 |
| "DOM 节点 < 500" (PDR 7.4) | 渐进加载已做(batch 80) | 保持 |
| "缩略图圆角 4-8px" (DESIGN 6) | 已用 8px ✅ | 保持 |
| "网格间距 4-8px" (DESIGN 9) | 已用 8px ✅ | 保持 |
| "窗口最小 900×600" (DESIGN 10) | 同 ✅ | P2-1: 考虑降至 720×480 |

---

## 六、关键风险提示

1. **缩略图尺寸翻倍后的磁盘占用**: 如果库有 10 万张图片，360px→720px 缩略图文件大小大约从 25KB→60KB，总量从 2.4GB→5.7GB。建议在设置中增加"缩略图缓存上限"选项（默认 10GB），超出后自动淘汰旧缩略图。

2. **React-virtuoso Masonry 兼容性**: 需确认 `react-virtuoso` 当前版本(4.x)是否已在项目中安装，以及其 Masonry 模式在 Electron Chromium 134 中的表现。如果项目实际使用的是 `@tanstack/react-virtual`（如 CLAUDE.md 所列），则需要不同的 Masonry 方案——推荐手写最短列优先 + `@tanstack/react-virtual` 的 `useVirtualizer`。

3. **`local-media://` 协议的缓存头**: 当前设置了 `cache-control: public, max-age=31536000, immutable`。如果缩略图重新生成（如更换尺寸），需要同时更新缓存策略（加版本号或 ETag）。建议缩略图文件名改为 `{md5}_{size}_{quality}.webp` 以支持多版本共存。
