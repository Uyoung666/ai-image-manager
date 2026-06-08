# AI Image Manager — User Guide

> 100% local AI image manager — all processing happens on your device, no data uploads.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Photo Browsing](#photo-browsing)
- [Search](#search)
- [AI Smart Index](#ai-smart-index)
- [Tag Management](#tag-management)
- [Face Recognition](#face-recognition)
- [Albums & Smart Albums](#albums--smart-albums)
- [Dashboard](#dashboard)
- [Photo Culling](#photo-culling)
- [Duplicate Detection](#duplicate-detection)
- [Batch Operations](#batch-operations)
- [Export & Share](#export--share)
- [Cloud Sync](#cloud-sync)
- [Trash](#trash)
- [Settings](#settings)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [FAQ](#faq)

---

## Quick Start

### 1. Add a Photo Folder

When you first open the app, click the **"Add Folder"** button and select the directory where your photos are stored.

The app will scan the folder for images (supporting 30+ formats including JPG, PNG, RAW, HEIC, WebP, AVIF), generate thumbnails, and extract EXIF metadata.

### 2. Wait for Scanning to Complete

Scanning progress is displayed in the sidebar and the status bar. You can continue using the app during scanning. Once complete, photos will appear in the main grid.

### 3. Enable AI Indexing

To enable natural language search (e.g., "autumn leaves at sunset"), you need to complete AI indexing. Click **"Start AI Indexing"** in the sidebar. The first run will download the AI model automatically.

**Note**: If you're in China and HuggingFace downloads are slow, switch the mirror source to hf-mirror.com or modelscope.cn in Settings.

---

## Photo Browsing

### Main Interface

- **Photo Grid**: Masonry layout, grouped by date
- **Sort Options**: Date (newest/oldest), Filename (A→Z / Z→A), File Size (largest/smallest)
- **Column Width**: Adjustable slider (140–320px), preference is remembered
- **Infinite Scroll**: Automatically loads more photos as you scroll down

### Selecting Photos

| Action | How |
|--------|-----|
| Single select | Click a photo |
| Multi-select | `Ctrl` + click |
| Range select | `Shift` + click |
| Select all | `Ctrl + A` |
| Marquee select | Click and drag on empty space |

When photos are selected, an action bar slides up from the bottom with favorite, album, export, rename, and delete options.

### Photo Detail Panel

Select a photo and press **`I`** to open the right-side detail panel:
- Basic info and EXIF metadata (camera, lens, focal length, aperture, shutter speed, ISO, GPS)
- Tag management (add, remove, AI-suggested tags)
- File path

Panel width is adjustable by dragging the edge; preference is remembered.

### Quick Preview

Select a photo and press **`Space`** for quick preview:
- Scroll wheel zoom (0.5x – 5x)
- Drag to pan (when zoomed >1x)
- Double-click to toggle 2x zoom
- Arrow keys to navigate

### Lightbox

Double-click a photo or press `Enter` to open the fullscreen lightbox:
- Infinite carousel browsing
- Slideshow mode (`Space` to toggle play/pause, 3/5/10s intervals)
- Thumbnail navigation strip
- Fullscreen mode

---

## Search

The search bar at the top supports three search modes:

### 1. Semantic Search

Type natural language descriptions into the search box, e.g.:
- "sunset beach"
- "autumn red leaves"
- "cat close-up"

The AI understands the semantic meaning and returns matching photos sorted by similarity.

### 2. Image Search

Drag an image file onto the search bar, or click the image button to select a file. The AI finds the most visually similar photos.

### 3. EXIF Filters

Click the filter button to filter by EXIF metadata:
- **Date Range**: Enter start/end dates in `YYYY-MM-DD` format
- **Camera Model**: Autocomplete suggestions from your indexed photos
- **ISO Range**: Min/max values
- **Aperture Range**: Min/max f/ values
- **Focal Length Range**: Min/max values (mm)

Active filters appear as chips that can be individually removed.

### Search History

Focusing the search box shows recent searches. Click "Clear all" to remove all history.

---

## AI Smart Index

### What is AI Indexing?

AI indexing uses a CLIP model to convert photos into vector embeddings, enabling semantic search and image similarity search. All computation runs locally — no data is ever uploaded.

### Three States

| State | Description |
|-------|-------------|
| **Not Started** | Shows "Start AI Indexing" button |
| **In Progress** | Shows progress bar with pause/resume controls |
| **Complete** | Shows "Index New Photos" button for incremental indexing |

### Mirror Settings

If HuggingFace downloads are slow or failing:
1. Go to **Settings → AI Model Mirror Settings**
2. Switch to `hf-mirror.com (Recommended)` or `modelscope.cn`
3. Save

---

## Tag Management

### Adding Tags

Three ways to tag photos:
1. **Sidebar drag & drop**: Drag photos onto a tag in the sidebar tree
2. **Detail panel**: Search for or create tags in the right-side panel
3. **Batch AI generation**: Click "Batch Generate AI Tags" in the sidebar to auto-tag all photos

### Tag Hierarchy

Parent-child tag hierarchy is supported. Right-click a tag → "Create Child Tag" to build a hierarchy.

### AI Tag Suggestions

In the detail panel, click "Analyze Suggested Tags" — the AI analyzes the photo and suggests tags with confidence scores. Click a suggestion to confirm it. Previously analyzed photos retain their suggestions when you navigate back (no need to re-analyze).

---

## Face Recognition

> **GPU Acceleration**: DirectML GPU acceleration delivers **6.6x faster** face detection. The app automatically detects your GPU on first launch and shows an onboarding dialog. Falls back to CPU if no compatible GPU is found.

### Starting Detection

1. Open the **People** page (sidebar navigation)
2. Click **"Start Face Detection"**
3. Wait for the scan to complete; progress updates every 2 seconds

### Managing People

| Action | How |
|--------|-----|
| Rename | Click the name on the person card to edit inline, Enter to save |
| Merge | Enter select mode, check multiple people → "Merge as Same Person" |
| Delete | Right-click a person → Delete |
| View Photos | Click the card to enter detail view |
| Remove from Person | In detail view, right-click a photo → "Remove from this person group" |

### Reclustering

If automatic grouping is inaccurate, click **"Recluster"** to re-run the clustering algorithm without re-scanning. To start fresh, click **"Rescan"** (clears all data and re-detects).

---

## Albums & Smart Albums

### Regular Albums

On the **Albums** page, click "New Album" and enter name/description. Add photos by:
- Selecting photos → action bar → "Add to Album"
- Right-click a photo → "Add to Album"
- Dragging photos onto an album name in the sidebar

### Smart Albums

Smart albums automatically match photos based on rules — no manual adding required.

**Available Rules**: Date range, camera model, lens model, tags, focal length, aperture, file format

**Preset Templates**:
- Last 7 / 30 days
- This Year
- This Day Last Year

A live count of matching photos is shown as you build rules.

---

## Dashboard

Open **Dashboard** for statistical analysis of your library:

| Section | Content |
|---------|---------|
| **Overview Cards** | Total photos, AI processed count, date range, average ISO |
| **Camera / Lens** | Usage frequency bar charts |
| **Focal / Aperture / ISO** | Distribution histograms |
| **Time** | 24-hour distribution, yearly trend, monthly breakdown |
| **Color** | Global palette, 12 hue distribution, saturation levels (vivid/moderate/muted) |
| **Map** | GPS-tagged photos on a map (online/offline modes) |

**Linked Search**: Click any chart bar or color swatch to jump back to the home page with the corresponding filter applied.

---

## Photo Culling

Quickly narrow down large batches to find the best shots. Ideal for post-shoot selection, travel photo curation, and similar workflows.

### Creating a Culling Session

Navigate to the **Culling** page via the sidebar and click "New Culling Session":

- **Name**: Give the session a label, e.g. "2025 Cherry Blossom Picks"
- **Mode**: PK (pairwise comparison) or Curate (single-photo review)
- **PK Sub-mode**: Quick (min 5 comparisons) / Standard (8) / Fine (12)

### PK Mode

Two photos side by side — pick the better one. Features:
- Synchronized zoom and pan (zooming one auto-syncs the other)
- Keyboard shortcuts: `1` pick left, `2` pick right, `3` skip
- EXIF overlay display
- Fatigue reminder (after every 50 comparisons)
- Undo last choice

The system uses an Elo rating algorithm — after multiple rounds of pairing, a final ranking is produced.

### Curate Mode

Review photos one at a time — keep or reject. Keyboard shortcuts: `Y` keep, `N` reject.

### Results

After culling is complete, the results view provides:
- **Leaderboard** — ranked by Elo score / win rate
- **Multi-select** — batch add to album, export, delete
- **Top-N export** — export the top N best photos in one click
- **Comparison details** — view per-photo win/loss records and rating history

---

## Duplicate Detection

### Scanning

Open the **Duplicate Photos** page — the app automatically scans and groups duplicates.

### Three Match Types

| Type | Description |
|------|-------------|
| **Exact Match** | File contents are identical |
| **Visually Identical** | AI determines the same image |
| **Highly Similar** | Perceptual hash match; may be burst shots or slight edits |

### Retention Strategy

- **Manual Selection**: Choose which to keep per group
- **Keep Larger File**: Auto-suggests deleting the smaller one
- **Keep Older Created**: Auto-suggests deleting the newer one

Select photos and click "Delete Selected" to batch remove. You can also "Ignore" a group to skip it.

---

## Batch Operations

Select multiple photos and use the bottom action bar:

| Action | Shortcut | Description |
|--------|----------|-------------|
| Favorite | `F` | Toggle favorite status |
| Add to Album | — | Add to existing or new album |
| Export | `Ctrl+Shift+E` | Export as ZIP, optional compression |
| Rename | `F2` | Batch rename with templates |
| Convert Format | `Ctrl+Shift+C` | Convert to WebP/AVIF/JPEG/PNG |
| Delete | `Delete` | Move to trash (recoverable within 30 days) |

### Batch Rename Tokens

- `{yyyy}` `{mm}` `{dd}` — Date components
- `{camera}` — Camera model
- `{iso}` `{focal}` — Shooting parameters
- `{index}` `{index:N}` — Sequence number
- `{orig}` — Original filename
- `{ext}` — File extension

Presets: `Date_Camera_Index`, `Date_Index`, `Original_Date`, `Date_Original`

---

## Export & Share

### Export ZIP

Press `Ctrl+Shift+E` or use the action bar. Two modes:
- **Original**: No re-compression, package directly
- **Compressed**: Adjustable quality (10–100%) and max width (640–3840px)

### Share Page

Generates a single-file HTML page with thumbnails, EXIF data, and tags. Upload to cloud storage to get a shareable link viewable in any browser.

### Watermark

Configure text or image watermarks in **Settings → Watermark Settings**. Automatically applied during export and format conversion. 9 anchor positions, adjustable margin/opacity/font size.

---

## Cloud Sync

### Supported Providers

- **WebDAV**: Compatible with Nutstore and other WebDAV services
- **Amazon S3**: AWS S3 and S3-compatible storage

### Configuration

1. Go to **Settings → Cloud Sync Configuration**
2. Click "Add Configuration"
3. Fill in connection details and click "Test"
4. Save

After configuration, you can upload photos and publish share pages to the cloud.

---

## Trash

Deleted photos go to the trash and are kept for **30 days** before automatic permanent deletion.

| Action | Description |
|--------|-------------|
| Restore | Select photos → Restore; they return to original locations |
| Permanent Delete | Select photos → Permanent Delete; irreversible |
| Empty Trash | Delete all photos in trash at once |

---

## Settings

### Appearance
- **Theme**: Dark / Light / Follow System
- **Language**: Chinese / English

### Indexing
- **Thumbnail Cache**: View cache size and location; clear with one click
- **Invalid Index Cleanup**: Remove records for files that have been moved or deleted

### Data Directory
- Change where app data is stored (database, thumbnails, AI models)
- Migration progress is displayed; do not close the app during migration

### AI Model Mirror
- Auto-detect / hf-mirror.com / modelscope.cn / Official / Custom
- Users in China should switch to hf-mirror.com

### GPU Acceleration

- **Auto-Detection**: GPU is automatically checked for DirectML support on first launch
- **Onboarding Dialog**: A one-click setup dialog appears when a compatible GPU is detected
- **Manual Toggle**: Settings → GPU Acceleration, toggle on/off anytime
- **Face Recognition Only**: GPU acceleration currently applies to face detection; CLIP embeddings and other AI tasks still use CPU

### Watermark
- Text or image watermark
- 9 anchor positions + drag to position
- Adjustable margin, opacity, font size / image scale
- Live Canvas preview

---

## Keyboard Shortcuts

Press **`?`** to open the shortcuts panel.

### Browse

| Shortcut | Action |
|----------|--------|
| `Space` | Quick preview selected photo |
| `←` `→` | Navigate photos in preview/lightbox |
| `↑` `↓` | Navigate photos in detail panel |
| `Esc` | Close preview/lightbox/panel |
| Double-click | Open lightbox |

### Select

| Shortcut | Action |
|----------|--------|
| Click | Select photo |
| `Ctrl` + Click | Toggle selection |
| `Shift` + Click | Range select |
| `Ctrl` + `A` | Select all |

### Actions

| Shortcut | Action |
|----------|--------|
| `F` | Toggle favorite |
| `Delete` | Delete selected |
| `F2` | Batch rename |
| `Ctrl` + `Shift` + `E` | Export |
| `Ctrl` + `Shift` + `C` | Convert format |

### Interface

| Shortcut | Action |
|----------|--------|
| `I` | Toggle detail panel |
| `[` | Toggle sidebar |
| `Ctrl` + `K` | Global search (Spotlight) |
| `?` | Keyboard shortcuts help |

### Lightbox

| Shortcut | Action |
|----------|--------|
| `Space` | Play/pause slideshow |
| `Esc` | Exit lightbox |

---

## FAQ

### Why doesn't search return any results?

AI indexing may not be complete. Check the sidebar AI progress bar — semantic search only works once indexing is done (or partially done).

### AI model download failed?

Go to **Settings → AI Model Mirror** and switch to `hf-mirror.com (Recommended)`. If that also fails, try a custom mirror URL.

### What happens when I move photo files?

The app does not track file moves. Moved photos will show as invalid records. Use **Settings → Indexing → Clean Invalid Records** to remove them.

### Where are my database and thumbnails stored?

In the app data directory (default location). You can view and change this in **Settings → Data Directory**, including migration to another drive.

### Face detection isn't accurate enough?

Try "Recluster" to improve grouping, or manually merge/split identities. The detection threshold is fixed at 0.55, balancing precision and recall.

### Face detection is too slow?

Enable GPU acceleration for up to **6.6x faster** face detection. Go to **Settings → GPU Acceleration → Enable**. Falls back to CPU automatically if your GPU doesn't support DirectML.

### Duplicate detection found nothing?

Visual duplicate detection requires AI indexing to be complete. Exact duplicates are always detectable.

### How long do deleted photos stay in trash?

30 days. After that, they are automatically and permanently deleted.

### What image formats are supported?

JPG, JPEG, PNG, WebP, AVIF, HEIC, HEIF, TIFF, BMP, GIF, RAW (CR2/CR3/NEF/ARW/DNG/RAF/RW2/ORF and more) — 30+ formats. RAW files are converted to previews via the sharp engine.
