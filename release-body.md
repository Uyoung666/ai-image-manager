@
## v1.3.3

### 新增功能 / New Features

- 重新设计选片布局：沉浸式毛玻璃 UI、框选、双视图结果对比 / Redesigned culling layout with immersive glass UI, marquee selection, and dual-view results
- 重新设计引导流程：全屏叙事式布局 / Redesigned onboarding with full-screen narrative layout
- PK 缩放体验对标 Windows 照片应用 / PK zoom UX matches Windows Photos behavior
- 选片功能新增 HEIC 格式 EXIF 读取和对比预览 / HEIC EXIF support and duel preview for culling

### 问题修复 / Bug Fixes

- 修复搜索/排序下拉菜单被照片网格工具栏遮挡 / Fix search/sort dropdown overlapped by photo grid toolbar
- 修复瀑布流顶部内边距不足导致工具栏重叠 / Fix insufficient masonry grid padding-top causing toolbar overlap
- 修复软删除照片出现在选片中的问题 / Fix soft-deleted photos appearing in culling
- 修复快捷键面板重复堆叠 / Fix stacked shortcut panels via stopImmediatePropagation
- 修复 EXIF 浮点值导致图表标签精度溢出 / Fix EXIF float precision overflow in chart labels
- 修复仪表盘 EXIF 统计数据鲁棒性和图表体验 / Fix dashboard EXIF stats robustness and chart UX

### 优化 / Improvements

- 全面代码优化：安全加固、性能提升、无障碍改进 / Comprehensive optimization: security hardening, performance, accessibility
- 搜索管线加固：熔断机制、延迟融合、颜色向量化、零样本回退 / Hardened search pipeline with circuit breaking, late fusion, color vectorization, zero-shot fallback

### 文档 / Documentation

- 修正 GUIDE 中 11 处错误（快捷键、阈值、更新/代理相关章节） / Fix 11 errors in GUIDE (shortcuts, thresholds, missing update/proxy sections)
@
