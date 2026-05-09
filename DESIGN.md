# DESIGN.md — AI Image Manager

> 基于 Linear 设计系统 (awesome-design-md/linear)
> 适用于: Electron + React + Tailwind CSS + shadcn/ui

---

## 1. Visual Theme & Atmosphere

超极简、精密、以功能为导向。冷色调暗色背景下，单一靛蓝紫 (#5E6AD2) 作为强调色。深色优先 — 让用户的照片成为视觉焦点。

- 每个像素都要有存在的理由
- 照片是内容主角，UI 是安静的框架
- 暗色环境下长时间使用不刺眼

---

## 2. Color Palette & Roles

### 暗色主题 (默认)

| CSS Variable | Hex | LCH | Usage |
|---|---|---|---|
| `--background` | `#08090a` | `lch(3% 2 270)` | 主画布 (照片网格背景) |
| `--background-secondary` | `#121214` | `lch(7% 1 280)` | 侧边栏 / 底部栏 |
| `--surface` | `#1c1e22` | `lch(12% 2 270)` | 卡片 / 面板 / Tooltip |
| `--surface-hover` | `#25272d` | `lch(16% 2 270)` | 悬停态 |
| `--surface-elevated` | `#2f3238` | `lch(20% 2 275)` | 弹窗 / 模态框 |
| `--foreground` | `#f7f8f8` | `lch(97% 0 0)` | 正文 (非纯白，护眼) |
| `--foreground-secondary` | `#a1a1aa` | `lch(65% 0 270)` | 辅助文字 |
| `--foreground-tertiary` | `#6b6b75` | `lch(44% 2 270)` | 占位符 / 禁用态 |
| `--primary` | `#5e6ad2` | `lch(55% 80 300)` | 强调色 (靛蓝紫) |
| `--primary-hover` | `#6e7af0` | `lch(62% 75 295)` | 强调色悬停 |
| `--border-subtle` | `rgba(255, 255, 255, 0.06)` | — | 微妙分割线 |
| `--border` | `#2c2c30` | `lch(18% 1 275)` | 可见边框 |
| `--ring` | `#5e6ad2` | — | 焦点环 |
| `--danger` | `#e5484d` | — | 删除 / 错误 |
| `--success` | `#46a758` | — | 成功状态 |
| `--warning` | `#ffb224` | — | 警告状态 |

### 亮色主题 (次要)

| CSS Variable | Hex | Usage |
|---|---|---|
| `--background` | `#fcfcfc` | 主画布 |
| `--surface` | `#ffffff` | 卡片 / 面板 |
| `--foreground` | `#1a1a1a` | 正文 |
| `--foreground-secondary` | `#6b6b75` | 辅助文字 |
| `--border` | `#e5e5e5` | 边框 |

### 强调色使用规则

- 每屏最多一个主 CTA 使用 primary 色
- 选中态 / 焦点环 / 进度条可用 primary
- 不要在非交互元素上使用 primary
- 暗色背景上优先使用透明度而非实体色按钮

---

## 3. Typography

### 字体族

| Token | Font Stack | Usage |
|---|---|---|
| `--font-sans` | Inter Variable, system-ui, sans-serif | 所有文字 |
| `--font-mono` | JetBrains Mono, SF Mono, monospace | 代码 / EXIF 原始值 / 文件路径 |

### 字重限制

**绝对规则: 字重上限 590。永远不要使用 700。**

| 字重 | Usage |
|------|------|
| 400 (Regular) | 正文 |
| 510 (Medium) | 特殊标签、子标题 (Linear 标志性字重) |
| 590 (Semibold) | 标题 (最粗限制) |

### 层级

| Level | Size | Weight | Letter Spacing | Line Height | Usage |
|---|---|---|---|---|---|
| Title XL | 24px | 590 | -0.02em | 1.2 | 仪表盘标题 |
| Title L | 18px | 590 | -0.015em | 1.3 | 面板标题 |
| Title M | 16px | 510 | -0.01em | 1.4 | 卡片标题 |
| Body | 14px | 400 | 0 | 1.5 | 正文 / 列表 |
| Small | 12px | 400 | 0 | 1.4 | EXIF 数据 / 辅助 |
| Label | 11px | 510 | +0.01em | 1.3 | 标签 / 徽章 |
| Code | 13px | 400 | 0 | 1.5 | 代码块 |

---

## 4. Component Styles

### Button

```
Primary:     bg-[--primary] text-white rounded-[6px] px-[14px] py-[6px]
              text-[13px] font-[510] h-8
              hover: opacity-90
Secondary:   bg-[--surface] text-[--foreground] border border-[--border]
              rounded-[6px] px-[14px] py-[6px]
              hover: bg-[--surface-hover]
Ghost:       text-[--foreground-secondary] hover:bg-[--surface-hover]
              rounded-[6px] px-[8px] py-[4px]
Danger:      bg-[--danger] text-white rounded-[6px]
```

**规则**: Primary 按钮每屏最多 1 个。暗色背景上不直接用实体色，用透明度。

### Input / Search

```
Input:       bg-[--surface] border border-[--border-subtle] rounded-[6px]
              px-[12px] py-[6px] text-[14px]
              focus: border-[--primary] ring-1 ring-[--ring]
              placeholder:text-[--foreground-tertiary]
```

### Card / Thumbnail

```
Card:        bg-[--surface] rounded-[8px] overflow-hidden
              border border-[--border-subtle]
              hover: bg-[--surface-hover]
Selected:    ring-2 ring-[--primary] bg-[--surface-hover]
```

### Sidebar

```
Sidebar:     bg-[--background-secondary] w-[240px]
              border-r border-[--border-subtle]
```

### Dialog / Panel

```
Panel:       bg-[--surface-elevated] rounded-[12px]
              border border-[--border]
              shadow: none (暗色模式用亮度层级代阴影)
```

### Badge / Tag

```
Badge:       bg-[--surface] text-[--foreground-secondary]
              rounded-[4px] px-[6px] py-[2px] text-[11px] font-[510]
```

---

## 5. Spacing System

4px 基础网格:

| Token | Value | Usage |
|---|---|---|
| `--space-1` | 4px | 紧密元素间 |
| `--space-2` | 8px | 标签间距 / 图标间距 |
| `--space-3` | 12px | 列表项内边距 |
| `--space-4` | 16px | 卡片内边距 |
| `--space-5` | 20px | 内容区边距 |
| `--space-6` | 24px | 面板内边距 |
| `--space-8` | 32px | 区块间距 |
| `--space-10` | 40px | 页面分区 |
| `--space-12` | 48px | 大区块分隔 |

特殊值: 7px / 11px — 光学补偿 (图标对齐等少数场景)

---

## 6. Border Radius

| Token | Value | Usage |
|---|---|---|
| `--radius-sm` | 4px | 徽章 / 标签 |
| `--radius-md` | 6px | 按钮 / 输入框 |
| `--radius-lg` | 8px | 卡片 / 缩略图 |
| `--radius-xl` | 12px | 弹窗 / 对话框 |
| `--radius-full` | 9999px | 头像 / 药丸形 |

---

## 7. Depth & Elevation

暗色模式下阴影几乎不可见。用**亮度层级**替代阴影:

| Level | Background | Usage |
|---|---|---|
| 0 (Canvas) | `--background` | 主内容区 / 网格 |
| 1 (Raised) | `--background-secondary` | 侧边栏 |
| 2 (Surface) | `--surface` | 卡片 / Tooltip |
| 3 (Overlay) | `--surface-hover` | 下拉菜单 |
| 4 (Modal) | `--surface-elevated` | 弹窗 / 模态框 |

每升一级，背景亮度 +5~8%。

---

## 8. Do's and Don'ts

### Do's

- 用亮度层级区分表面，不用阴影
- 慎用品牌色 — 每屏仅用于最重要的一个操作
- 保持 WCAG AA 对比度 (正文 4.5:1)
- 圆角保持一致 — 只用 4/6/8/12/full 五档
- 最大字重 590，不越界
- 照片网格背景用 `--background` (#08090a)，让图片发光
- 使用透明度处理悬停态: `hover:bg-white/5`
- 键盘导航完整覆盖

### Don'ts

- 不使用字重 700 及以上
- 不混用圆角和直角
- 不使用厚重阴影 (暗色模式下纯属浪费)
- 不过度使用强调色
- 不使用纯白 `#ffffff` 正文 (用 `#f7f8f8`)
- 不堆叠多个主 CTA 在同一视图
- 不添加纯装饰性元素

---

## 9. Photo-Specific Guidelines

- 缩略图网格背景: `--background` (最暗层，让照片弹出)
- 选中缩略图: ring-2 ring-[--primary]
- 网格间距: 4px (紧凑) 或 8px (舒适)，默认 4px
- 缩略图圆角: 4px (小图) / 8px (大图)
- 缩略图长宽比: 保持原始比例，用 object-fit: cover + aspect-ratio
- 加载骨架屏: 深灰色脉冲 (`--surface` → `--surface-hover`)
- 悬停信息覆盖: 半透明深色渐变底部叠加

---

## 10. Responsive Behavior

窗口最小尺寸: 900×600px。侧边栏可折叠，网格自适应列数。

| Breakpoint | Columns | Thumb Size |
|---|---|---|
| >= 1400px | 6-8 | 220px |
| >= 1200px | 5-6 | 200px |
| >= 1000px | 4-5 | 180px |
| >= 900px | 3-4 | 160px |

---

## Quick Reference — shadcn/ui CSS Variables

```css
@layer base {
  :root {
    --background: 210 10% 3%;
    --foreground: 180 8% 97%;
    --card: 220 10% 12%;
    --card-foreground: 180 8% 97%;
    --popover: 220 10% 15%;
    --popover-foreground: 180 8% 97%;
    --primary: 237 55% 60%;
    --primary-foreground: 0 0% 100%;
    --secondary: 240 4% 13%;
    --secondary-foreground: 180 8% 97%;
    --muted: 240 5% 12%;
    --muted-foreground: 240 5% 65%;
    --accent: 237 55% 60%;
    --accent-foreground: 0 0% 100%;
    --destructive: 358 75% 59%;
    --destructive-foreground: 0 0% 100%;
    --border: 240 4% 18%;
    --input: 240 4% 18%;
    --ring: 237 55% 60%;
    --radius: 0.5rem;
  }

  .light {
    --background: 0 0% 99%;
    --foreground: 0 0% 10%;
    --card: 0 0% 100%;
    --card-foreground: 0 0% 10%;
    --popover: 0 0% 100%;
    --popover-foreground: 0 0% 10%;
    --primary: 237 55% 55%;
    --primary-foreground: 0 0% 100%;
    --secondary: 240 5% 96%;
    --secondary-foreground: 0 0% 10%;
    --muted: 240 5% 96%;
    --muted-foreground: 240 4% 45%;
    --border: 240 5% 90%;
    --input: 240 5% 90%;
    --ring: 237 55% 60%;
  }
}
```
