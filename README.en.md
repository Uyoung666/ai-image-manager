# AI Image Manager

**100% Local AI Image Manager** — Search your photo library with natural language, no cloud uploads required.

Double-click to launch. Index folders in-place (no copying of original files). CLIP semantic search, smart deduplication, auto-tagging, face recognition, and cloud sharing.

[![Version](https://img.shields.io/badge/version-1.0.1-blue)](#)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-0078d7)](#)

> **中文 README**: [README.md](README.md)
> **User Guide**: [GUIDE.en.md](GUIDE.en.md) | **使用指南**: [GUIDE.md](GUIDE.md)

---

## Screenshots

| | | |
|:---:|:---:|:---:|
| **Home / Browse** | **Keyboard Shortcuts** | **Duplicate Detection** |
| ![Home](screenshots/01-home.png) | ![Shortcuts](screenshots/02-keyboard-shortcuts.png) | ![Duplicates](screenshots/03-duplicate-detection.png) |
| **Fullscreen Preview** | **Photo Details** | |
| ![Preview](screenshots/04-lightbox-preview.png) | ![Details](screenshots/05-photo-detail.png) | |

## Download & Install

Download the latest version from the [Releases](https://github.com/Uyoung666/ai-image-manager/releases) page. Each release includes a demo video.

### Option 1: Installer (Recommended)

Download `AI Image Manager-1.0.1 Setup.exe` and run the setup wizard.

- Installs to the default system location (`%LocalAppData%\AI Image Manager`)
- Creates desktop shortcut and Start Menu entry automatically
- Supports automatic updates

### Option 2: Portable

Download `AI Image Manager-win32-x64-1.0.1.zip`, extract to any directory, and run `AI Image Manager.exe`.

- No registry writes, no shortcuts created
- Run from a USB drive or external disk
- Data stored in the `data/` folder within the extracted directory

---

## First-Time Setup

### Users in China

The release installer bundles AI models. On first launch, models are copied from the installer to the local data directory — no network download is usually needed.

**If model files are corrupted or accidentally deleted, the app will attempt to re-download them:**

1. **Option 1: Configure a mirror in Settings**
   - Go to Settings → AI Model Mirror Settings
   - Users in China are recommended to use `hf-mirror.com`
   - Save and restart AI indexing

2. **Option 2: Manual model download**
   ```powershell
   cd ai-image-manager
   .\scripts\download-model.ps1
   ```

3. **Option 3: Manually place model files**
   - Download model files from [hf-mirror.com](https://hf-mirror.com/Xenova/clip-vit-base-patch32/tree/main)
   - Place them in: `%APPDATA%\AI Image Manager\models\Xenova\clip-vit-base-patch32\`

### International Users

The release installer also bundles AI models. Network download only occurs as a fallback when model files are missing.

---

## Features

### Core Browsing
- **In-place folder indexing** — no copying or moving of original files
- **Virtual-scrolled masonry layout** — smooth 60fps browsing for 100K+ images
- **Three-tier thumbnail cache** — memory LRU → disk → on-demand generation
- **Timeline grouping** — organize photos by year/month/day
- **Folder tree sidebar** — drag-and-drop navigation, filesystem watch auto-sync
- **Quick preview (Space)** — macOS QuickLook-style
- **Fullscreen lightbox** — auto slideshow with adjustable interval

### AI Search
- **Natural language search** — supports Chinese and English, e.g. "sunset photos from last autumn at the beach"
- **Reverse image search** — drag in a reference image to find similar photos
- **Compound search** — keywords + time range + EXIF conditions

### EXIF Dashboard
- Camera/lens usage frequency statistics
- Focal length distribution histogram
- Aperture/shutter speed/ISO preference analysis
- Capture time heatmap
- Color distribution analysis (hue/saturation/lightness)
- GPS location map

### Smart Deduplication
- pHash perceptual hash for fast pre-screening
- CLIP vector similarity for precise ranking
- Side-by-side comparison + batch cleanup

### Tag System
- **AI auto-tagging** — 136 candidate tags across 9 categories (scene/people/animals/objects/activity/lighting/style/color/weather)
- **Tag hierarchy** — parent-child tag tree view
- **Manual tags** — add, edit, delete, confirm or reject AI suggestions

### Face Recognition
- ONNX face detection + feature extraction
- Automatic identity clustering
- Identity merging and management

### Batch Processing
- Batch rename (EXIF-based templates)
- Format conversion (WebP/AVIF/JPG/PNG/TIFF)
- Resize + compress
- Text watermark

### Albums
- **Smart albums** — rule-engine auto-aggregation (date/EXIF/tags/AND/OR)
- **Manual albums** — drag-and-drop sorting

### Cloud Sharing
- **WebDAV / S3-compatible** — one-click upload after configuring cloud storage
- **Share page generation** — generates standalone HTML pages with embedded thumbnails + EXIF + tags, supporting search and lightbox browsing

### System Integration
- System tray with context menu
- Auto-start on boot (optional)
- Global shortcuts (Ctrl+Shift+F search, Ctrl+Shift+H hide/show)
- Windows "Send to" integration
- Soft delete + recycle bin recovery

### More
- Light / Dark / System theme, Linear Dark design system
- Chinese / English i18n
- Keyboard-friendly (press `?` to view all shortcuts)

---

## Performance Benchmarks

> Test environment: Windows 11, Ryzen 7, 16GB RAM, NVMe SSD, CLIP ViT-B/32 quantized model running locally

| Photo Count | Phase 1 — Scan & Index | Phase 2 — AI Embeddings | **Total** |
|------|:-----------:|:------------:|:------:|
| **1,000** | ~1 min | ~1.5 min | **~2.5 min** |
| **10,000** | ~7 min | ~15 min | **~22 min** |
| **100,000** | ~70 min | ~40 min | **~1.8 hrs** |

- Phase 1: pHash perceptual hash + EXIF parsing + thumbnail generation (4 concurrent workers)
- Phase 2: CLIP vector embeddings (2-worker process pool)
- After the initial full import, subsequent incremental indexing is near-instant (filesystem watch auto-triggers)

---

## Tech Stack

| Layer | Technology |
|----|------|
| Desktop Framework | Electron 41 |
| Frontend | React 19 + TypeScript 6 (strict) |
| Build | Vite 8 + Tailwind CSS 4 |
| UI Components | shadcn/ui + Radix UI |
| Routing | TanStack Router (file-based) |
| IPC | oRPC (type-safe) |
| State Management | TanStack Query |
| Database | better-sqlite3 + Drizzle ORM |
| Image Processing | sharp |
| AI Inference | Transformers.js (ONNX Runtime) |
| Vector Storage | LanceDB |
| Testing | Vitest + Playwright |
| Packaging | Electron Forge + Squirrel (Windows) |

---

## Development

### Prerequisites
- Node.js 22+
- Windows 10/11 (currently Windows-only)
- Git

### Quick Start

```bash
# Clone the repository
git clone https://github.com/Uyoung666/ai-image-manager.git
cd ai-image-manager

# Install dependencies
npm install

# Start development mode
npm run dev
```

### Common Commands

```bash
npm run dev           # Start dev mode (Vite HMR + Electron)
npm run make          # Package Windows installer
npm run test          # Run unit tests
npm run test:e2e      # Run end-to-end tests
npm run check         # Lint
npm run fix           # Auto-fix
npm run db:generate   # Generate database migrations
npm run db:migrate    # Run database migrations
```

---

## Architecture

```
Main Process
  ├── Database: better-sqlite3 + Drizzle ORM
  ├── Image Processing: sharp
  ├── AI Inference: Transformers.js + LanceDB
  ├── File Watching: chokidar
  ├── Thumbnails: Three-tier cache (memory LRU → disk → on-demand)
  └── IPC Server: oRPC MessagePort

AI Workers (separate processes to avoid ONNX/sharp conflicts)
  ├── Embedding generation (CLIP)
  └── Face detection + feature extraction

Renderer Process
  ├── React 19 + TanStack Router
  ├── shadcn/ui components
  └── oRPC Client (type-safe IPC calls)
```

---

## Privacy

- **100% local processing** — your images never leave your computer
- **Zero data upload** — no telemetry, no analytics, no background uploads
- **Cloud features are opt-in** — upload/sharing only triggers after you manually configure cloud storage
- **AI models run locally** — CLIP, face detection, and other models run via ONNX Runtime on your machine

---

## License

MIT © Uyoung

---

## Acknowledgments

This project is built on the [electron-shadcn](https://github.com/LuanRoger/electron-shadcn) template.
