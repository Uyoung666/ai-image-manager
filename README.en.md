# AI Image Manager

<div align="center">

**A local-first AI photo manager for Windows**

Index, search, organize, curate, and analyze your photo library with AI—without uploading your images.

[![Latest Release](https://img.shields.io/github/v/release/Uyoung666/ai-image-manager?display_name=tag&style=flat-square)](https://github.com/Uyoung666/ai-image-manager/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D4?style=flat-square&logo=windows11&logoColor=white)](#system-requirements)
[![License](https://img.shields.io/github/license/Uyoung666/ai-image-manager?style=flat-square)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-41-47848F?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org/)

[Website](https://ai-image-manager.uyoungvision.cn) · [Download](https://github.com/Uyoung666/ai-image-manager/releases/latest) · [User Guide](GUIDE.en.md) · [简体中文](README.md)

</div>

---

## Overview

AI Image Manager provides an end-to-end local workflow for importing, finding, organizing, curating, and sharing photos. It indexes your existing folders in place, so you do not need to move or duplicate your library. Thumbnails, metadata, vector indexes, and AI inference data remain on your computer.

All core photo-management and AI features work locally. Data is sent to a remote service only when you explicitly configure WebDAV or S3 and initiate an upload or sharing action.

![AI Image Manager home screen](screenshots/01-home.png)

## Why AI Image Manager

- **Local-first by design:** photos, EXIF metadata, vector indexes, and face features remain on your device by default, with no telemetry or background uploads.
- **Content-aware search:** describe a scene in natural language or use a reference image to find visually similar photos.
- **A complete photography workflow:** browse, organize, compare, analyze, export, and share from one desktop application.
- **Built for large libraries:** virtualized masonry rendering, incremental indexing, and isolated AI workers are designed to scale.
- **Broad format support:** manage common formats alongside HEIC, TIFF, and major camera RAW formats.

## Quick Start

### Download and Install

Get the latest build from [GitHub Releases](https://github.com/Uyoung666/ai-image-manager/releases/latest):

- **Installer (recommended):** integrates with Windows, creates shortcuts, and supports automatic updates.
- **Portable build:** extract and run without installing the application.

On first launch, the setup wizard helps you choose a data directory, configure optional DirectML GPU acceleration, and select the interface language. AI models are bundled with the application, so no additional first-run download is required.

> For detailed workflows, keyboard shortcuts, and troubleshooting, see the [User Guide](GUIDE.en.md).

### System Requirements

| Component | Requirement |
| --- | --- |
| Operating system | Windows 10 or 11, 64-bit |
| Processor | x64 processor |
| Memory | 8 GB recommended; 16 GB or more for large libraries |
| Storage | SSD recommended, with additional space for thumbnails, indexes, and AI models |
| GPU | Optional; a DirectML-compatible GPU can accelerate face detection, with automatic CPU fallback |

## Core Features

### AI Search and Smart Organization

- Natural-language semantic search in English and Chinese—for example, “sunset at the beach last autumn”
- Reverse image search, filename wildcards, and compound filters for dates, tags, and EXIF metadata
- `Ctrl+K` Spotlight search across photos, tags, albums, people, and application navigation
- AI-assisted tagging and rule-based smart albums using dates, EXIF fields, tags, and AND/OR conditions

### Fast Browsing and Photo Management

- Virtualized masonry layout, timeline grouping, and a hierarchical folder tree
- Quick preview, fullscreen lightbox, slideshows, EXIF details, and precise scroll restoration
- Drag-and-drop import, marquee selection, favorites, batch rename, format conversion, resize, and watermark tools
- Soft deletion with a 30-day trash, including restore and cleanup controls

| Quick Preview | Photo Details |
| :---: | :---: |
| ![Fullscreen lightbox](screenshots/04-lightbox-preview.png) | ![EXIF details](screenshots/05-photo-detail.png) |

### Professional Photo Culling

- **PK mode:** Elo-based pairwise comparison with Quick, Standard, and Fine intensity levels
- **Curate mode:** keyboard-first keep, reject, and skip decisions for individual photos
- **Results view:** ranked output with Top-N selection, multi-select, album actions, and batch export

| PK Comparison | Curate Mode | Ranked Results |
| :---: | :---: | :---: |
| ![PK comparison](screenshots/11-culling-pk.png) | ![Curate mode](screenshots/12-culling-curate.png) | ![Culling results](screenshots/13-culling-result.png) |

### People, Duplicates, and Photo Analytics

- ONNX-based face detection and feature extraction with automatic identity clustering, rename, merge, and split controls
- DirectML GPU acceleration with automatic CPU fallback; embedded previews enable RAW processing
- pHash pre-screening combined with CLIP similarity ranking for duplicate and near-duplicate review
- EXIF dashboards for camera, lens, focal length, aperture, shutter speed, ISO, capture time, color, and GPS distributions
- Interactive chart drill-down that opens the matching photos directly

| People | Duplicate Detection | Analytics Dashboard |
| :---: | :---: | :---: |
| ![Face recognition](screenshots/06-face-detection.png) | ![Duplicate detection](screenshots/03-duplicate-detection.png) | ![Analytics dashboard](screenshots/07-dashboard.png) |

### Export, Sharing, and Windows Integration

- Batch-export original or compressed photos as a ZIP archive
- Generate standalone HTML galleries containing thumbnails, EXIF metadata, and tags
- Optionally configure WebDAV or S3-compatible storage and manually upload photos or galleries
- System tray, launch-at-login, global shortcuts, and Windows Send To integration

## How It Works

```text
Local photo folders
       │
       ├── Scan and watch ─────► SQLite metadata / EXIF
       ├── Thumbnails and pHash ► Browsing, preview, duplicate detection
       └── AI workers ─────────► CLIP vectors / face features ─► LanceDB
                                        │
                                        └── Semantic search, reverse image search,
                                            and identity clustering
```

The application does not copy or take ownership of your original library. The indexer reads folders you select and writes derived data to a configurable application data directory. File changes are synchronized through incremental filesystem monitoring.

## Supported Image Formats

| Category | Formats |
| --- | --- |
| Common formats | JPEG, PNG, WebP, AVIF, TIFF, HEIC / HEIF, GIF, BMP, ICO |
| Camera RAW | CR2, CR3, NEF, NRW, ARW, SRF, SR2, DNG, ORF, RW2, RAF, PEF, RWL, 3FR, RAW |

For RAW files, thumbnails, previews, and AI analysis primarily use the embedded JPEG preview. Results depend on whether the camera file contains a usable preview.

## Performance Reference

The following measurements were recorded on Windows 11 with a Ryzen 7 processor, 16 GB RAM, an NVMe SSD, and a quantized CLIP ViT-B/32 model. They illustrate expected scale only; actual performance varies with file format, resolution, storage speed, and hardware.

| Photos | Scan, EXIF, and Thumbnails | AI Embeddings | Total |
| ---: | ---: | ---: | ---: |
| 1,000 | ~1 min | ~1.5 min | **~2.5 min** |
| 10,000 | ~7 min | ~15 min | **~22 min** |
| 100,000 | ~70 min | ~40 min | **~1.8 hr** |

After the initial full index, newly added or changed photos are processed incrementally.

## Local Development

### Prerequisites

- Windows 10 or 11
- [Node.js 22](https://nodejs.org/), matching the CI environment
- npm
- A Windows C++ build environment for native dependencies

### Run the Project

```bash
git clone https://github.com/Uyoung666/ai-image-manager.git
cd ai-image-manager
npm ci
npm run dev
```

The `npm ci` postinstall step rebuilds native dependencies—including `better-sqlite3`, LanceDB, and Transformers.js—for Electron.

### Commands

| Command | Description |
| --- | --- |
| `npm run dev` | Start Electron with Vite hot reload |
| `npm test` | Run the Vitest suite once |
| `npm run test:e2e` | Run Playwright end-to-end tests |
| `npm run check` | Check formatting and lint rules |
| `npm run fix` | Apply safe automatic formatting and fixes |
| `npm run make` | Build Windows distributables |
| `npm run db:generate` | Generate Drizzle database migrations |
| `npm run db:migrate` | Apply pending database migrations |

## Technical Architecture

| Layer | Main Technologies |
| --- | --- |
| Desktop runtime | Electron 41, Electron Forge |
| Renderer | React 19, TypeScript, TanStack Router / Query |
| UI and styling | Tailwind CSS 4, shadcn/ui, Radix UI |
| Type-safe communication | oRPC |
| Data and indexing | SQLite, better-sqlite3, Drizzle ORM, LanceDB |
| Images and metadata | sharp, ExifTool, exifr |
| AI inference | Transformers.js, ONNX Runtime, DirectML |
| Tooling and tests | Vite 8, Vitest, Playwright, Biome / Ultracite |

Key directories:

```text
src/
├── routes/       # React pages and routes
├── components/   # UI components
├── actions/      # Renderer-side IPC wrappers
├── ipc/          # Typed IPC routes and handlers
├── services/     # Indexing, thumbnails, AI, faces, and cloud services
├── db/           # Database schema and access layer
└── tests/        # Unit, integration, and end-to-end tests
```

## Privacy

AI Image Manager's core workflow runs locally. The application contains no telemetry, behavioral analytics, or unsolicited photo uploads. When cloud sharing is enabled, it communicates with the configured WebDAV or S3 service only after you explicitly initiate an upload. Availability, access controls, and privacy terms for remote storage are governed by the selected provider.

## Documentation

- [English User Guide](GUIDE.en.md)
- [中文使用指南](GUIDE.md)
- [中文 README](README.md)
- [Releases and Downloads](https://github.com/Uyoung666/ai-image-manager/releases)

## License

This project is available under the [MIT License](LICENSE). Copyright © Uyoung.

The project was originally bootstrapped from [electron-shadcn](https://github.com/LuanRoger/electron-shadcn).
