# AI Image Manager

<div align="center">

**A local-first AI photo manager for Windows**

Index, search, organize, curate, analyze, and share your photo library on your own computer without moving the original files.

[![Release](https://img.shields.io/badge/release-v2.0.0-2563EB?style=flat-square)](https://github.com/Uyoung666/ai-image-manager/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D4?style=flat-square&logo=windows11&logoColor=white)](#system-requirements)
[![License](https://img.shields.io/github/license/Uyoung666/ai-image-manager?style=flat-square)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-41-47848F?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org/)

[Website](https://ai-image-manager.uyoungvision.cn) · [Download v2.0.0](https://github.com/Uyoung666/ai-image-manager/releases/latest) · [User Guide](GUIDE.en.md) · [简体中文](README.md)

</div>

---

## v2.0.0: a new public baseline

v2.0.0 is the new public starting point for AI Image Manager. It is designed for photographers, creators, designers, and anyone with a long-lived photo library on Windows. The workflow is built around your existing folders: index them in place, find photos with natural language, visual similarity, metadata, or folders, then organize, curate, analyze, export, or share them.

The v2.0.0 documentation, performance data, and privacy statements describe the current release only. They do not make an upgrade, data-format, or feature-continuity promise for historical releases.

## Product principles

- **Local-first**: photos, thumbnails, EXIF, AI vectors, and face features are processed and stored on your computer by default.
- **In-place indexing**: the app reads folders you choose and does not require copying or migrating your original photos.
- **Network by intent**: automatic updates contact the update service; WebDAV/S3 and diagnostic submission create the corresponding network activity only when enabled or initiated by the user.
- **Designed for real libraries**: incremental indexing, a virtualized gallery, and isolated AI workers support libraries that keep growing.
- **One photography workflow**: browsing, culling, people management, duplicate review, EXIF analysis, export, and sharing live in one desktop app.

![AI Image Manager home screen](screenshots/v2.0.0/home.png)

## Quick start

### Download and install

Download v2.0.0 from [GitHub Releases](https://github.com/Uyoung666/ai-image-manager/releases/latest):

- **Installer**: recommended for long-term use, with Windows installation, shortcuts, and update support.
- **Portable build**: extract and run without installing into the system installation directory.

On first launch, the setup flow helps you:

1. Choose the application data directory for the database, thumbnails, vector index, and local models.
2. Detect and optionally enable DirectML GPU acceleration.
3. Select Chinese or English as the interface language.

The release package includes the model assets required by the current version, so a normal installation does not need an extra model download on first use. If model files are missing or fail verification, the app may offer to retrieve them; that recovery action requires network access.

### Import your first folder

1. Click **Add Folder** on the home page, or drop a photo folder into the app window.
2. Let the background queue scan files, create thumbnails, and read EXIF metadata. You can continue browsing existing photos while the queue runs.
3. Watch **AI Smart Index** in the sidebar. Semantic search, image search, visual duplicate detection, and some AI tagging features require their corresponding index to be ready.

For detailed workflows, shortcuts, and troubleshooting, read the [User Guide](GUIDE.en.md).

## System requirements

| Component | Requirement |
| --- | --- |
| Operating system | Windows 10 or 11, 64-bit |
| Processor | x64 processor |
| Memory | 8 GB recommended; 16 GB or more for large libraries |
| Storage | SSD recommended, with room for thumbnails, database, vector index, and models |
| GPU | Optional; DirectML-capable NVIDIA, AMD, or Intel GPU can accelerate some AI tasks, with CPU fallback |
| Runtime | Visual C++ 2015–2022 x64 Redistributable may be required if an AI Worker or native dependency fails to start |

Actual performance depends on image format, resolution, library storage, system load, CPU, GPU, and memory.

## Main capabilities

### 1. AI search and global search

- Natural-language semantic search in Chinese and English, such as “去年秋天的红叶” or “sunset by the beach”.
- Image search: choose a reference image and find visually similar photos.
- Filename wildcard matching, such as `IMG_*.jpg`, `*2025*`, and `DSC_00??.ARW`.
- Combined filters for date, camera, lens, focal length, aperture, ISO, format, and tags.
- Press `Ctrl+K` for global search across photos, tags, albums, people, settings, and navigation.
- If AI is unavailable or indexing is incomplete, filename, tag, people, and metadata search remain available; semantic results require the relevant index.

### 2. Browsing and photo management

- Virtualized masonry gallery, timeline grouping, and a tree of your real folders.
- Single selection, multi-selection, range selection, marquee selection, favorites, and scroll restoration.
- Press `Space` for quick preview. Double-click to open the lightbox with fullscreen, slideshow, zoom, pan, rotation, and thumbnail navigation.
- A detail panel for file information, EXIF, tags, location, and the original path.
- Folder appearance settings for colors and icons inside the app; they do not modify real folders on disk.
- Soft deletion and a 30-day trash with restore, cleanup, and Windows system recycle-bin handling.

| Quick preview | Photo details |
| :---: | :---: |
| ![Quick preview](screenshots/v2.0.0/quick-preview.png) | ![EXIF details](screenshots/v2.0.0/photo-detail.png) |

### 3. AI indexing, tags, and people

- Local image embeddings for semantic search and visual similarity.
- Pause, resume, and incremental processing for newly added photos.
- Manual tags, nested tag hierarchies, and AI tag suggestions.
- Local face detection and feature extraction with identity clustering, naming, merging, hiding, splitting, and reclustering.
- DirectML can accelerate image embedding and face recognition. The app falls back to CPU when probing or runtime execution fails.

| People management | AI indexing and duplicates |
| :---: | :---: |
| ![People](screenshots/v2.0.0/people.png) | ![Duplicate detection](screenshots/v2.0.0/duplicates.png) |

### 4. Albums, sequences, and Wander

- Regular albums for manual organization, removal, and cover selection.
- Smart albums that match rules for dates, camera, lens, tags, focal length, aperture, ISO, and format.
- Sequence detection for burst photography and timelapse sets, with strict, balanced, relaxed, and custom presets.
- Sequence management with frame browsing, playback, representative-photo selection, reordering, and splitting.
- Wander for manual or idle-time rediscovery through time capsules, themes, and overlooked-library selections; save a Wander round as an album.

### 5. Professional photo culling

- **Duel / PK mode**: compare two photos and build a ranking with Elo scoring.
- **Curate mode**: review photos one by one and mark them keep, reject, or skip similar photos.
- Quick, Standard, and Fine PK strategies, synchronized zoom, EXIF overlays, undo, and fatigue reminders.
- Results with rankings, Top-N marking, multi-selection, album actions, export, and trash actions.

| PK comparison | Curate mode | Ranked results |
| :---: | :---: | :---: |
| ![PK comparison](screenshots/v2.0.0/culling-pk.png) | ![Curate mode](screenshots/v2.0.0/culling-curate.png) | ![Culling results](screenshots/v2.0.0/culling-export.png) |

### 6. Duplicate review and photo analytics

- Detect groups that are byte-for-byte identical, visually identical, or visually similar.
- Combine file hashes, perceptual hashes, and visual similarity for candidate grouping. Visual similarity is not proof of a duplicate; review before cleanup.
- Keeper selection, ignored groups, and batch cleanup protected by the 30-day trash.
- Dashboard views for overview, gear, exposure, technique, time, places, and color.
- Drill down from charts to matching photos, with all-time, current-year, last-12-month, and custom date ranges.

![Analytics dashboard](screenshots/v2.0.0/dashboard-1.png)

### 7. Batch processing, export, and sharing

- Batch favorites, album actions, renaming, format conversion, resizing, and watermarks.
- Export originals or compressed versions as ZIP archives; compressed export supports quality and maximum-width settings.
- Generate a single-file HTML gallery with thumbnails, EXIF metadata, and tags.
- Text or image watermarks with nine anchor positions, opacity, font/image scale, and preview.
- Optional system tray, launch at login, global shortcuts, and Windows Send To integration.

### 8. Cloud storage and sharing

Supported user-configured providers:

- **WebDAV**: suitable for Nutstore and other compatible WebDAV services.
- **Amazon S3 / S3-compatible storage**: requires endpoint, bucket, access key, secret key, and related settings.

Cloud configuration does not upload photos automatically. Data is sent to the selected provider only after the user configures it and explicitly uploads photos or publishes a share page. Availability, permissions, and privacy terms are controlled by the provider.

## v2.0.0 interface gallery

These screenshots come from the v2.0.0 tested interface and cover preview, sequences, albums, settings, culling, and dashboard workflows.

| Lightbox | Face review |
| :---: | :---: |
| ![Lightbox](screenshots/v2.0.0/lightbox.png) | ![Face review](screenshots/v2.0.0/face-review.png) |

| Sequences and sequence details | Smart albums |
| :---: | :---: |
| ![Sequences and sequence details](screenshots/v2.0.0/sequences.png) | ![Smart albums](screenshots/v2.0.0/smart-albums.png) |

| Keyboard shortcuts | Settings |
| :---: | :---: |
| ![Keyboard shortcuts](screenshots/v2.0.0/keyboard-shortcuts.png) | ![Settings](screenshots/v2.0.0/settings.png) |

| Culling workspace | Analytics dashboard (2) |
| :---: | :---: |
| ![Culling workspace](screenshots/v2.0.0/culling-overview.png) | ![Analytics dashboard (2)](screenshots/v2.0.0/dashboard-2.png) |

![Analytics dashboard (3)](screenshots/v2.0.0/dashboard-3.png)

## Supported image formats

| Category | Formats |
| --- | --- |
| Common formats | JPG, JPEG, PNG, WebP, AVIF, TIFF, TIF, HEIC, HEIF, GIF, BMP, ICO |
| Camera RAW | CR2, CR3, NEF, NRW, ARW, SRF, SR2, DNG, ORF, RW2, RAF, PEF, RWL, 3FR, RAW |

The indexer accepts 27 extensions. RAW thumbnails, previews, and AI analysis primarily use embedded JPEG previews read with ExifTool. RAW files without a usable embedded preview may have limited support.

## Performance reference

This is the only recorded end-to-end observation for the current release:

| Workload | Import | AI embedding | Total |
| ---: | ---: | ---: | ---: |
| 1,000 photos | 30 seconds | 32 seconds | **62 seconds** |

This result comes from one real run with 1,000 photos. The test hardware, image formats, resolutions, and system load were not fully recorded, so this is a single-run baseline rather than a guarantee for every computer, library, or image type. It must not be used to extrapolate fixed times for 10,000 photos or larger libraries.

## How the app handles your data

```text
Folders you choose
        │
        ├─ Scan and watch ───► SQLite / EXIF / file state
        ├─ Thumbnails ───────► Local cache / gallery / lightbox
        └─ AI Workers ───────► SigLIP vectors / face features / AI tags
                                      │
                                      └─► Semantic search, image search,
                                          people clustering, duplicate review

Derived data lives in the application data directory; original photos remain in your folders.
```

The app does not take ownership of or automatically migrate your original photos. If source files are moved or deleted, their index records may become invalid and can be cleaned from Settings. The database, thumbnails, vector index, models, and logs are controlled by the data-directory setting.

## Privacy, network, and diagnostics

- Photo indexing, thumbnail generation, EXIF reading, vector computation, face features, and search processing run locally by default.
- The app does not automatically upload photo content. Photos, databases, EXIF, face/vector data, and search terms are not included in diagnostic bundles.
- When automatic updates are enabled, the app contacts the update service to check for and download releases. Configure automatic updates, reminders, and proxy settings under **Settings → Software Update**.
- When WebDAV/S3 is configured and an upload or share action is initiated, the corresponding data is sent to the selected service.
- **Settings → Help & Diagnostics** creates a strictly redacted diagnostic bundle locally. It is not uploaded automatically; it leaves the device only if the user exports it or attaches it to an Issue. Native crash dumps are off by default.

These statements describe the current v2.0.0 implementation and do not replace the privacy policies of connected cloud or update services.

## Bundled AI models and licenses

The release package includes the model assets required by the current version. See [THIRD_PARTY_MODEL_NOTICES.md](THIRD_PARTY_MODEL_NOTICES.md) and [`licenses/`](licenses) for full notices. All of the following models run locally and have separate responsibilities:

| Model | Main capabilities | Explicit boundary | License |
| --- | --- | --- | --- |
| **SigLIP Base Patch16-224** | Image and text embeddings in one 768-dimensional, L2-normalized vector space; text-to-image search, image-to-image search, AI tag suggestions, visual duplicate detection, and similar-candidate grouping | Not for image generation, photo editing, OCR, or face recognition | Apache License 2.0 |
| **OPUS-MT Chinese to English** | Translates Chinese search queries to English locally so they can enter the SigLIP text-embedding flow | Does not generate images or extract image/face features, and is not a general-purpose translation service | CC BY 4.0 |
| **YuNet** | Local face detection and five-point facial-landmark localization; outputs face boxes and locations for the people workflow | Does not identify people and does not provide general image embeddings or semantic search | MIT License |
| **SFace** | Local 128-dimensional face embeddings for face similarity, people clustering, and people management | Does not detect faces and does not provide general image embeddings or text-to-image search | Apache License 2.0 |

### Current standard model capabilities

The current standard embedding adapter is `siglip-v1-base-patch16-224` (SigLIP Base Patch16-224):

- Provides both image and text embeddings in one 768-dimensional, L2-normalized vector space.
- Supports Chinese and English semantic search, or text-to-image search.
- Supports image-to-image search and visual-similarity ranking.
- Provides the image/label similarity used for AI tag suggestions.
- Supports visual duplicate detection and visually similar candidate groups.
- Uses the current officially calibrated `siglip-v1-base-patch16-224-default` threshold profile.

Before entering the text-to-image flow, Chinese queries may be translated to English locally by OPUS-MT; people-related capabilities are handled separately by YuNet (detection and landmarks) and SFace (face features). Model output supports similarity, retrieval, and assisted organization; it is not an absolute judgment about photo content.

## Local development

### Prerequisites

- Windows 10 or 11
- [Node.js 22](https://nodejs.org/)
- npm
- A Windows C++ build environment for native dependencies such as `better-sqlite3`, LanceDB, Sharp, and ONNX Runtime

### Run the project

```bash
git clone https://github.com/Uyoung666/ai-image-manager.git
cd ai-image-manager
npm ci
npm run dev
```

`npm ci` rebuilds Electron native modules. Prepare development model files according to the project instructions; release builds stage only the assets listed in the approved model manifest.

### Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Electron + Vite development environment |
| `npm test` | Run Vitest tests |
| `npm run test:e2e` | Run Playwright E2E tests |
| `npm run check` | Run formatting and lint checks |
| `npm run make` | Build Windows distribution packages |
| `npm run db:generate` | Generate a Drizzle migration |
| `npm run db:migrate` | Apply database migrations |

## Technical architecture

| Layer | Main technologies |
| --- | --- |
| Desktop runtime | Electron 41, Electron Forge |
| Renderer | React 19, TypeScript, TanStack Router / Query |
| UI | Tailwind CSS 4, Radix UI, shadcn/ui |
| Data and indexes | SQLite, better-sqlite3, Drizzle ORM, LanceDB |
| Images and metadata | Sharp, ExifTool, exifr |
| AI inference | Transformers.js, ONNX Runtime, DirectML |
| Engineering and testing | Vite, Vitest, Playwright, Biome / Ultracite |

Key directories:

```text
src/routes/       React pages and routes
src/components/   Reusable UI components
src/actions/      Renderer-side IPC wrappers
src/ipc/          Typed IPC routes and handlers
src/services/     Indexing, thumbnails, AI, people, cloud, and related services
src/db/           Database schema and access layer
src/tests/        Unit, integration, and E2E tests
```

## Documentation

- [中文使用指南](GUIDE.md)
- [English User Guide](GUIDE.en.md)
- [中文 README](README.md)
- [Third-party model notices](THIRD_PARTY_MODEL_NOTICES.md)
- [Releases and downloads](https://github.com/Uyoung666/ai-image-manager/releases)

## License

This project is released under the [MIT License](LICENSE). Third-party models and dependencies retain their own licenses; read [THIRD_PARTY_MODEL_NOTICES.md](THIRD_PARTY_MODEL_NOTICES.md) and the notices in [`licenses/`](licenses).
