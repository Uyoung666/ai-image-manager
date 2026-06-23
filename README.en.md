# AI Image Manager

**100% Local AI Image Manager** — search, organize, and curate your photo library with AI, entirely offline.

Index folders in-place. Semantic search, smart albums, face recognition, photo culling, deduplication, cloud sharing — all running locally on your machine.

[![Version](https://img.shields.io/badge/version-1.3.3-blue)](#)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-0078d7)](#)

> **中文 README**: [README.md](README.md)
> **User Guide**: [GUIDE.en.md](GUIDE.en.md) | **使用指南**: [GUIDE.md](GUIDE.md)

---

## Download

Get the latest version from [Releases](https://github.com/Uyoung666/ai-image-manager/releases). Each release includes a demo video.

**Installer (Recommended):** `AI Image Manager-1.3.3 Setup.exe` — installs to `%LocalAppData%`, creates shortcuts, auto-updates.

**Portable:** `AI Image Manager-win32-x64-1.3.3.zip` — extract anywhere, run directly, no registry writes.

---

## Features

### Browsing & Lightbox

Virtual-scrolled masonry layout, 60fps with 100K+ photos. Timeline grouping, folder tree, QuickLook-style preview, fullscreen lightbox with slideshow.

| ![Home](screenshots/01-home.png) | ![Lightbox](screenshots/04-lightbox-preview.png) |
|:---:|:---:|
| Home | Lightbox |
| ![Photo Detail](screenshots/05-photo-detail.png) | ![Shortcuts](screenshots/02-keyboard-shortcuts.png) |
| EXIF Detail | Keyboard Shortcuts |

### AI Search

Natural language queries in Chinese or English — *"sunset at the beach last autumn"*. Reverse image search. Compound filtering with keywords, time range, and EXIF conditions.

**`Ctrl+K` Spotlight Search** — command-palette overlay for global search across photos, tags, albums, people, and navigation. Pinyin initial matching, full keyboard navigation.

### Photo Culling

Rate, compare, and narrow down large batches. Three modes:

- **PK Mode** — Elo-based pairwise comparison with three intensity levels (Quick/Standard/Fine)
- **Curate Mode** — single-photo keep/reject with keyboard shortcuts
- **Result View** — ranked export with multi-select, Top-N, album, and batch actions

| ![Culling Sessions](screenshots/10-culling.png) | ![PK Mode](screenshots/11-culling-pk.png) |
|:---:|:---:|
| Sessions | PK Comparison |
| ![Curate Mode](screenshots/12-culling-curate.png) | ![Results](screenshots/13-culling-result.png) |
| Curate | Ranked Results |

### EXIF Dashboard

Camera/lens usage stats, focal/aperture/shutter/ISO distributions, capture time heatmap, color analysis (hue/saturation/lightness), GPS map. Click any chart bar to drill down into matching photos.

| ![Overview](screenshots/07-dashboard.png) | ![Color Analysis](screenshots/07b-dashboard-2.png) |
|:---:|:---:|
| Overview | Color Analysis |

### Face Recognition

ONNX-based detection and feature extraction. Automatic identity clustering, merge/split, rename. **DirectML GPU acceleration delivers 6.6x faster face detection**, with automatic CPU fallback. Works with RAW files via embedded JPEG preview.

| ![Face Detection](screenshots/06-face-detection.png) | ![Smart Album](screenshots/08-smart-album.png) |
|:---:|:---:|
| Face Recognition | Smart Albums |

### More

- **Smart Albums** — rule-engine auto-curation (date, EXIF, tags, AND/OR combinators)
- **Duplicate Detection** — pHash pre-screening + CLIP similarity ranking, batch cleanup
- **AI Auto-Tagging** — 136 tags across 9 categories (scene, people, animals, objects, style, weather...)
- **Batch Operations** — rename, format-convert, resize, watermark
- **Cloud Sharing** — WebDAV / S3 upload, standalone HTML share pages
- **Native Interactions** — drag-drop import, right-click context menus, marquee selection, clipboard copy
- **Scroll Restoration** — precise scroll position remembered across navigation (back/forward)
- **System Tray** — global shortcuts, auto-start, Send-To integration, soft-delete with 30-day trash

| ![Duplicates](screenshots/03-duplicate-detection.png) | ![Settings](screenshots/09-settings.png) |
|:---:|:---:|
| Duplicate Detection | Settings |

---

## First-Time Setup

**Three-step onboarding wizard** — guided setup on first launch:

1. **Data Directory** — choose where thumbnails, vectors, and models are stored; supports migration from existing locations
2. **GPU Setup** — one-click DirectML detection; enable for 6.6× faster face detection
3. **Complete** — language auto-detected from your system (Chinese/English), AI models pre-bundled in the installer

To re-detect GPU or change settings later: **Settings → GPU Acceleration**.

---

## Performance

> Windows 11, Ryzen 7, 16GB RAM, NVMe SSD, CLIP ViT-B/32 quantized, local inference

| Photos | Scan & Index | AI Embeddings | **Total** |
|--------|:-----------:|:------------:|:------:|
| **1K** | ~1 min | ~1.5 min | **~2.5 min** |
| **10K** | ~7 min | ~15 min | **~22 min** |
| **100K** | ~70 min | ~40 min | **~1.8 hr** |

Phase 1: pHash + EXIF + thumbnails (4 concurrent). Phase 2: CLIP embeddings (2-worker pool). Incremental indexing after initial import is near-instant.

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Desktop | Electron 41 |
| Frontend | React 19 + TypeScript (strict) |
| Build | Vite 8 + Tailwind CSS 4 |
| UI | shadcn/ui + Radix UI |
| IPC | oRPC (type-safe) |
| DB | better-sqlite3 + Drizzle ORM |
| Images | sharp |
| AI | Transformers.js + onnxruntime-node (DirectML GPU) + LanceDB |
| Test | Vitest + Playwright |

---

## Development

```bash
git clone https://github.com/Uyoung666/ai-image-manager.git
cd ai-image-manager
npm install
npm run dev
```

Requires Node.js 22+ and Windows 10/11.

```bash
npm run make          # Package Windows installer
npm run test          # Unit tests
npm run test:e2e      # E2E tests
npm run check         # Lint
```

---

## Privacy

**100% local.** No telemetry, no cloud uploads, no analytics. AI models run on your machine via ONNX Runtime. Cloud sharing only triggers when you manually configure it.

---

## License

MIT © Uyoung

Built on [electron-shadcn](https://github.com/LuanRoger/electron-shadcn).
