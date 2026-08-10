# AI Image Manager v2.0.0 User Guide

> A local-first photo manager for Windows. Build an index over your existing folders, then search, organize, curate, analyze, export, and share your library.

This guide follows the normal user workflow. v2.0.0 is the new public starting point; it describes the current release and makes no upgrade or data-format promise for historical releases.

---

## Contents

- [Before you start](#before-you-start)
- [Quick start](#quick-start)
- [Photo browsing](#photo-browsing)
- [Search](#search)
- [Folder navigation](#folder-navigation)
- [AI Smart Index](#ai-smart-index)
- [Custom AI models](#custom-ai-models)
- [Tag management](#tag-management)
- [People management](#people-management)
- [Albums and Smart Albums](#albums-and-smart-albums)
- [Sequence management](#sequence-management)
- [Wander](#wander)
- [Dashboard](#dashboard)
- [Photo culling](#photo-culling)
- [Duplicate detection](#duplicate-detection)
- [Batch operations](#batch-operations)
- [Export, sharing, and watermarks](#export-sharing-and-watermarks)
- [Cloud storage](#cloud-storage)
- [Trash](#trash)
- [Settings](#settings)
- [Privacy, network, and diagnostics](#privacy-network-and-diagnostics)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [FAQ](#faq)

---

## Before you start

AI Image Manager reads the photo folders you choose. It creates a database, thumbnails, vector indexes, local model data, and logs in the application data directory. Importing does not automatically move or copy your original photos.

### Supported systems

- Windows 10 or 11, 64-bit
- x64 processor
- 8 GB RAM recommended; 16 GB or more for large libraries
- SSD recommended, with space for derived data
- DirectML GPU optional; unsupported systems use CPU

Actual timing depends on image format, dimensions, storage, system load, and hardware. The only recorded 1,000-photo observation is 30 seconds to import, 32 seconds for AI embedding, and 62 seconds total. This is a single observation, not a fixed performance guarantee.

### File formats

The app accepts JPG, JPEG, PNG, WebP, AVIF, TIFF, TIF, HEIC, HEIF, GIF, BMP, ICO, plus camera RAW formats including CR2, CR3, NEF, NRW, ARW, SRF, SR2, DNG, ORF, RW2, RAF, PEF, RWL, 3FR, and RAW: 27 extensions in total.

RAW thumbnails, previews, and AI analysis primarily use embedded JPEG previews read with ExifTool. RAW files without a usable embedded preview may have limited support.

---

## Quick start

### 1. First-run onboarding

The first-run flow covers:

1. **Data directory**: choose where the database, thumbnails, vector indexes, logs, and models are stored.
2. **GPU acceleration**: detect DirectML and decide whether to enable it.
3. **Finish**: choose Chinese or English and enter the home page.

The release package includes the AI models required by the current version, so a normal first launch does not need an additional download. If a model is missing or fails verification, the app may request a recovery download, which requires network access.

Do not close the app while the data directory is being migrated. The interface and index state refresh after migration completes.

### 2. Add a photo folder

1. Click **Add Folder** on the home page.
2. Choose a folder containing photos, or drop a folder into the window.
3. Let the import queue process the files.

The queue scans supported extensions, reads basic information and EXIF, creates thumbnails, and prepares AI tasks. Import runs in the background, so processed photos can be viewed while the queue continues.

The app records the selected folder and watches for later changes. New or changed files enter incremental processing. If a file is moved to a location the app cannot follow, the old record becomes invalid.

### 3. Read import progress

The home page and sidebar show scanning and AI status. Import, thumbnail creation, and AI embedding are separate phases: photos can be browsed before AI is ready, while semantic and image search require the relevant index.

### 4. Recommended first workflow

1. Add a small folder and confirm that paths and previews look correct.
2. Check EXIF and RAW previews on several photos.
3. Start AI indexing and wait for the progress to settle.
4. Verify semantic search and image search.
5. Add more year, project, or client folders.
6. Run people recognition, duplicate detection, sequence detection, or culling as needed.

---

## Photo browsing

### Main interface

- **Sidebar**: all photos, folders, tags, albums, people, duplicates, culling, dashboard, trash, and settings.
- **Search bar**: semantic search, filename search, image search, and precise filters.
- **Photo grid**: a virtualized masonry gallery grouped by date and loaded as needed.
- **Bottom action bar**: favorites, albums, export, rename, convert, share, and delete actions for selected photos.

The toolbar supports sorting by capture date, filename, and file size. Adjusted gallery column width is remembered.

### Selecting photos

| Action | Method |
| --- | --- |
| Single selection | Click a photo |
| Multi-selection | `Ctrl` + click |
| Range selection | `Shift` + click |
| Select all | `Ctrl + A` |
| Marquee selection | Drag over empty grid space |
| Clear selection | Click empty space or press `Esc` |

Use the bottom action bar or the context menu after selecting photos. Before delete, move-to-trash, or batch rename actions, confirm the selection count.

### Photo detail panel

Press `I` or use the detail action to open the right panel. It can show:

- Filename, path, dimensions, size, and capture time
- Camera, lens, focal length, aperture, shutter, ISO, and GPS EXIF
- Tag management and AI tag suggestions
- People relationships and related status

The panel can be resized. Long paths and filenames are truncated with the full value available on hover or focus.

### Quick preview

Select a photo and press `Space`:

- `←` / `→` moves between photos
- See filename, dimensions, and date
- Drag the photo to another application
- Copy the image or reveal it in File Explorer
- Press `Enter` to open the lightbox

### Lightbox

Double-click a photo, or press `Enter` from quick preview:

- `Space` plays or pauses the slideshow
- Scroll to zoom, drag to pan, double-click to toggle fit and actual pixels
- `R` rotates clockwise; `Shift + R` rotates counter-clockwise
- `0` fits the window; `1` shows actual pixels
- `T` toggles the thumbnail navigator
- `I` toggles the information panel
- Fullscreen and configurable slideshow intervals are available

Lightbox actions affect the viewing session and do not rewrite the original file. Rotation and slideshow state are not automatically written to photo metadata.

---

## Search

The home search bar supports several modes. Date, tag, and EXIF constraints can be combined with a search.

### 1. Semantic search

Enter a natural-language description, for example:

- `落日海滩`
- `秋天的红叶`
- `猫咪特写`
- `sunset by the beach`

The local AI converts the text into a query vector and returns photos ranked by visual-semantic relevance.

Semantic search requires the image and text indexes. If AI is still processing, the model is unavailable, or the vector database is being repaired, the app shows the current state. Filename, tag, people, and metadata search remain available.

### 2. Image search

Drop a reference image into the search bar, or click its image button and choose a file. The app computes visual features for the reference and searches photos with existing vectors.

The reference image does not need to be imported first. Clear the reference image to return to normal search.

### 3. EXIF and precise filters

Click the filter button to combine:

- Capture date range
- Camera and lens model
- Minimum and maximum ISO
- Minimum and maximum aperture
- Minimum and maximum focal length
- Available format, tag, and favorite filters

Active conditions appear as filter chips and can be removed individually or cleared at once.

Use `YYYY-MM-DD` for dates. Photos without the relevant EXIF are not assigned an invented capture date; interpret results together with metadata coverage.

### 4. Filename wildcards

Useful for camera originals, export batches, and naming templates:

| Example | Meaning |
| --- | --- |
| `IMG_*.jpg` | JPG files beginning with `IMG_` |
| `*2025*` | Filenames containing `2025` |
| `DSC_00??.ARW` | ARW files with two characters after `DSC_00` |

### 5. Global search

Press `Ctrl + K` to search across:

- Photos, folders, and filenames
- Tags and albums
- People
- Settings and feature destinations

Global search is for fast navigation and is separate from the full semantic search on the home page.

### Search history

Recent searches appear when the search field is focused. Click **Clear all** to remove them. Search history is a local interface preference and is not included in diagnostic bundles.

---

## Folder navigation

The sidebar folder tree follows the real directory hierarchy of indexed folders. Parent folders aggregate photo counts from their children.

### Folder appearance

Folder appearance is an in-app setting and does not modify directories on disk:

1. Right-click a folder in the sidebar.
2. Select **Folder Appearance**.
3. Choose a color and icon badge.
4. Save.

If source files are moved or deleted, counts and valid records update after refresh, reindexing, or invalid-index cleanup.

---

## AI Smart Index

### What AI indexing does

AI indexing uses local vision models to create image vectors for semantic search, image search, visual duplicate detection, and some AI tag features. Computation runs on your computer by default.

### Index states

| State | Meaning |
| --- | --- |
| Not started | Start AI Indexing is available |
| Running | Progress is shown; pause or cancel is available |
| Paused | Completed results are kept and processing can resume |
| Complete | New photos can be indexed incrementally |
| Needs repair | The vector database or model state needs a retry or rebuild |

Import and AI indexing are separate. After adding a new folder, prefer incremental indexing instead of reprocessing completed photos.

### GPU acceleration

DirectML can be used for image embedding and face recognition:

1. Detect the GPU in step 2 of onboarding, or open **Settings → Acceleration**.
2. Click **Detect GPU**.
3. Enable the setting if DirectML is available.
4. Restart the indexing task for the change to apply.

If probing fails, the GPU is unsupported, or runtime execution fails, the app falls back to CPU. The speedup depends on the GPU, driver, image set, and concurrency; a result from one device is not a universal guarantee.

### Bundled models

The release includes the following local models. Their responsibilities are separate: standard semantic and visual retrieval is provided by SigLIP (with OPUS-MT translating Chinese queries when needed), while the people-recognition pipeline uses YuNet + SFace.

| Model | Capabilities | Used for | Does not do |
| --- | --- | --- | --- |
| **SigLIP Base Patch16-224** | Image and text embeddings in one 768-dimensional, L2-normalized vector space | Chinese/English text-to-image search, image-to-image search, AI tag suggestions, visual duplicate detection, and similar-photo candidate groups | Image generation, photo editing, OCR, or face recognition |
| **OPUS-MT Chinese to English** | Local Chinese-to-English query translation | Converts Chinese search terms before they enter SigLIP text embeddings for Chinese semantic search | Image generation, image/face feature extraction, or general-purpose translation |
| **YuNet** | Face detection and five-point facial-landmark localization; outputs face boxes and locations | Finds faces and supplies locations/landmarks to the people workflow | Identity recognition, general image embeddings, or semantic search |
| **SFace** | 128-dimensional face embeddings | Face similarity, people clustering, and people management | Face detection, general image embeddings, or text-to-image search |

See [THIRD_PARTY_MODEL_NOTICES.md](THIRD_PARTY_MODEL_NOTICES.md) for sources, versions, purposes, and licenses.

### Current standard model capabilities

The current standard embedding adapter is `siglip-v1-base-patch16-224` (SigLIP Base Patch16-224). It provides:

- Image and text embeddings in one 768-dimensional, L2-normalized vector space.
- Text-to-image search for Chinese and English natural-language queries.
- Image-to-image search based on visual similarity.
- Image/label similarity for AI tag suggestions.
- Visual duplicate detection and visually similar candidate groups.

The standard model uses the officially calibrated `siglip-v1-base-patch16-224-default` threshold profile. Chinese queries may be translated to English locally by OPUS-MT before entering the text-to-image flow; people-related capabilities are handled separately by YuNet (detection and landmarks) and SFace (face features). Model results support retrieval and assisted organization and should still be reviewed against the actual photo content.

### Custom AI models

The current release uses **SigLIP v1** as its standard embedding model. External model import, model switching, and user-facing model downloads are not available.

The project keeps a pluggable model-adapter layer for future extensions. A future adapter can connect an external model without changing the database schema, changing search business logic, or increasing the default installer size, provided the model is properly adapted and calibrated.

A custom model must provide:

- Image and text embedding
- Fixed vector dimensions and normalization rules
- A model artifact manifest with SHA-256 values
- Image preprocessing and output configuration
- A stable model fingerprint
- An independent threshold profile
- A vector index isolated from the active model

After changing models, the old vector store cannot be reused directly. A new vector index must be built and matched to the model fingerprint. An uncalibrated custom model is not used for automatic tag acceptance or duplicate-photo confirmation.

This release exposes the extension foundation only. It does not provide a custom-model UI, model download flow, or bundled support in the installer. Custom model integration is a developer capability; placing model files in the `models` directory does not enable them. See the [AI Model Adapter Developer Guide](docs/AI_MODEL_ADAPTER_GUIDE.md) for the adapter protocol and acceptance requirements.

---

## Tag management

### Add tags

Use any of these methods:

1. Drag photos onto a tag in the sidebar.
2. Search for or create a tag in the detail panel.
3. Use AI tag suggestions or the batch generation action.

Tags are stored as application organization data and are not automatically written into the original image files.

### Tag hierarchy

Right-click a tag and choose **Create Child Tag**. For example:

```text
Travel
├─ Japan
├─ Seaside
└─ Autumn
```

### AI tag suggestions

In the photo detail panel, click **Analyze Suggested Tags**:

1. Wait for the local model to analyze the image.
2. Review the suggestions and confidence values.
3. Click a suggestion to confirm it, or close the panel without applying it.

Suggestions remain available after analysis so you do not need to re-run it immediately.

---

## People management

People recognition uses local face detection and feature clustering. It is an organization aid; review before merging people or applying batch actions.

### Start face detection

1. Open **People** from the sidebar.
2. Click **Start Face Detection**.
3. Wait for detection, feature extraction, and clustering to finish.

Progress is shown during the scan. DirectML is optional, with automatic CPU fallback.

### Manage people

| Action | Method |
| --- | --- |
| Name | Edit the name on a people card and press Enter |
| View photos | Click a people card |
| Merge | Select multiple people and choose **Merge People** |
| Hide | Use the more-actions menu on a people card |
| Remove from person | Select photos in the person detail and remove the relationship |
| Reclustering | Run clustering again without scanning every photo |
| Rescan | Clear the current face results and detect again |

Lighting, angle, occlusion, face size, and image quality affect grouping. Correct mistakes with merge, split, removal, or reclustering.

---

## Albums and Smart Albums

### Regular albums

On **Albums**, click **New Album** and enter a name and optional description. Add photos by:

- Selecting photos on the home page → bottom action bar → **Add to Album**
- Right-clicking photos → **Add to Album**
- Dragging photos to an album in the sidebar

Albums store application relationships and do not copy original files.

### Smart Albums

Smart Albums match photos using rules instead of a manually maintained member list. Available rules include dates, camera, lens, tags, focal length, aperture, ISO, and format.

To create one:

1. Click **New Smart Album**.
2. Enter a name and description.
3. Add one or more matching conditions.
4. Review the live match count.
5. Save.

Common presets include the last 7 days, last 30 days, this year, and this day last year. Photos missing a field required by a rule do not match that rule.

---

## Sequence management

Sequences organize burst and timelapse photos and reduce repetitive browsing.

### Detect sequences

1. Open **Settings → Sequence Detection**.
2. Choose Strict, Balanced, Relaxed, or Custom.
3. Return to the photo or sequence view and click **Detect Sequences**.
4. Wait while the app groups candidates using capture rhythm and visual similarity.

Strict favors fewer false positives. Relaxed favors recall. Balanced is the default.

### Review and adjust

Open a sequence to:

- Expand all frames
- Play the sequence
- Select or accept a recommended representative photo
- Reorder frames
- Split the sequence from a selected frame
- Return to the normal photo view

Sequence detection creates in-app relationships only. It does not delete photos or modify files in the source folder.

---

## Wander

Wander helps rediscover the library when you are not running a specific search.

### Start manually

Open **Settings → Wander** and click **Start Now**. Wander requires at least two available photos.

### Automatic idle Wander

Enable **Wander when idle**, then choose:

- Idle time: 10, 15, or 30 minutes
- Photo interval: 3, 5, or 10 seconds
- Content mode: automatic rotation, time capsule, theme, rediscovery, or hamster wheel

Automatic Wander starts only while the app is visible, no dialog is open, and no background task is running.

### Save a round

Pause or exit at any time. Choose **Save Round as Album** to store the current selection as a regular album. Photos are organized, not copied.

---

## Dashboard

Open **Dashboard** for library statistics and shooting insights. Choose all time, this year, the last 12 months, or a custom date range.

| Area | Contents |
| --- | --- |
| Overview | Photo count, selected range, date coverage, and library health |
| Gear | Brand, camera, and lens distributions |
| Exposure | Focal length, aperture, ISO, shutter, and exposure mode |
| Technique | Focus, metering, white balance, drive mode, and other available EXIF |
| Time | Year, month, date, and time-of-day patterns |
| Places and color | GPS map, color coverage, hue, and saturation |

Click a chart category, bar, or color to drill down to matching photos on the home page. Missing EXIF or advanced metadata lowers chart coverage but does not affect normal browsing.

---

## Photo culling

Culling is useful for travel, events, burst sets, and pre-edit selection. Open **Culling** from the sidebar and click **New Cull**.

### Create a session

Choose:

- A session name, such as “Hokkaido selection”
- A source folder or photos selected on the home page
- **PK / Duel** or **Curate** mode
- Quick, Standard, or Fine PK strategy
- Sort by time or similarity

### PK / Duel mode

Compare two photos side by side:

- `←` pick the left photo
- `→` pick the right photo
- `Space` or `↓` skip
- `D` mark a draw
- `Ctrl + Z` undo
- `+` / `-` zoom
- `0` fit to screen
- Scroll to zoom, drag to pan, double-click to toggle actual pixels

Both sides can synchronize zoom and pan. Sync may be unavailable for photos with very different aspect ratios. Multiple comparisons produce an Elo-based ranking, and a break reminder appears after extended comparison.

### Curate mode

Review one photo at a time:

- `→` keep
- `←`, `↓`, or `Space` reject
- `S` skip similar photos
- `Ctrl + Z` undo

Zoom, pan, EXIF review, and actual-pixel inspection work the same way as in PK mode.

### Process results

The result view supports:

- Sorting by rating, status, or date
- Entering a count and marking Top-N as kept
- Batch keep, reject, album, and export actions
- Moving rejected photos to the 30-day trash
- Duplicating or deleting a culling session; deleting a session does not delete photos

Culling results assist decisions and do not overwrite originals automatically.

---

## Duplicate detection

### Scan

Open **Duplicate Photos** and start a scan. Exact duplicates can be reviewed without AI indexing; visually identical and visually similar groups require the relevant perceptual or AI analysis.

### Match types

| Type | Meaning |
| --- | --- |
| Exact duplicate | File contents are identical |
| Visually identical | The visual model considers them the same image, though files may differ |
| Visually similar | Could be a burst, crop, edit, or alternate export |

Visual similarity is not permission to delete. Review size, EXIF, sharpness, and intended use before choosing a keeper.

### Cleanup workflow

1. Open a duplicate group.
2. Keep at least one photo.
3. Remove false positives or ignore the group.
4. Click **Clean Up** and verify the count and estimated space.
5. Confirm; selected files move to the app trash instead of being immediately destroyed.

---

## Batch operations

After selecting multiple photos, the bottom action bar provides:

| Action | Shortcut | Description |
| --- | --- | --- |
| Favorite | `F` | Toggle favorite state |
| Add to album | — | Add to an existing or new album |
| Export | `Ctrl + Shift + E` | Export original or compressed ZIP |
| Batch rename | `F2` | Generate names from a template |
| Convert | `Ctrl + Shift + C` | Convert to JPG, PNG, WebP, or AVIF |
| Delete | `Delete` | Move to the app trash |

### Batch rename tokens

- `{yyyy}`, `{mm}`, `{dd}`: capture date
- `{camera}`: camera model
- `{iso}`, `{focal}`: ISO and focal length
- `{index}`, `{index:N}`: sequence number and optional width
- `{orig}`: original filename
- `{ext}`: extension

Presets include `Date_Camera_Index`, `Date_Index`, `Original_Date`, and `Date_Original`. Batch rename changes filenames on disk; review the preview and conflict warnings before applying it.

---

## Export, sharing, and watermarks

### ZIP export

Press `Ctrl + Shift + E` or use the bottom action bar:

- **Original**: package the source files without recompression.
- **Compressed**: choose quality and maximum width for delivery or web sharing.

Choose an output directory. Export does not change the originals in the library.

### HTML share page

The share action creates a single-file HTML page with thumbnails, EXIF, and tags. Save it locally or publish it to a configured WebDAV/S3 provider.

Access control and retention after cloud publication are controlled by the provider. Review location, people, and client metadata before publishing a page to an untrusted space.

### Watermarks

Open **Settings → Watermark** to:

- Choose a text or image watermark
- Use nine anchors or drag the preview to position it
- Adjust margin, opacity, font size, or image scale
- Apply it to export and format conversion output

Watermarks apply to output files and do not modify originals.

---

## Cloud storage

### Providers

- **WebDAV**: compatible with Nutstore and other WebDAV services.
- **Amazon S3 / S3-compatible storage**: supports custom endpoints, buckets, and access credentials.

### Configure a provider

1. Open **Settings → Cloud Sync**.
2. Click **Add Configuration**.
3. Choose WebDAV or S3.
4. Enter the URL, bucket, account, credentials, and related fields.
5. Click **Test**, then save.

### Upload and share

After configuration, use a photo selection, context menu, or share dialog to start an upload. Saving cloud settings does not upload the library automatically.

Provider permissions, encryption, access controls, costs, and privacy policies are controlled by the provider. Never expose access keys, secret keys, or WebDAV passwords in an Issue, log, or screenshot.

---

## Trash

Deleted photos first enter the app trash for 30 days. After that, they are moved to the Windows system recycle bin; final recovery depends on the system recycle bin and later user actions.

| Action | Description |
| --- | --- |
| Restore | Return a photo to its original location |
| Move to system recycle bin | End the app retention period early |
| Empty | Move all app-trash photos to the system recycle bin |

If a source file was moved or deleted outside the app, restoration to its original location may not be possible. Confirm backups and selection scope before permanent cleanup.

---

## Settings

### Appearance and interaction

- Dark, Light, or Follow System theme
- Chinese / English
- Accent color, UI scale, and reduced motion
- Search sensitivity
- Default sidebar state
- Close behavior: quit, minimize to tray, or ask
- Remember window position and size

### Storage and indexing

- View and change the data directory
- Migrate the database, thumbnails, vector index, and models
- View thumbnail cache size and location
- Clear the thumbnail cache
- View database location and valid/invalid index counts
- Clean records for source files that were moved or deleted

### GPU acceleration

Use **Settings → Acceleration** to detect, enable, or disable DirectML. GPU acceleration applies mainly to image embedding and face recognition; restart the indexing task after changing it. Probe or runtime failures fall back to CPU.

### Sequence detection

Use **Settings → Sequence Detection** to choose Strict, Balanced, Relaxed, or Custom. Custom settings include minimum timelapse frames, rhythm tolerance, and visual-distance threshold. Stricter values reduce false grouping; relaxed values may improve recall but require more review.

### Wander

Use **Settings → Wander** to configure idle time, photo interval, automatic activation, and content mode. Automatic Wander runs only while the app is visible, no dialog is open, and no background task is active.

### Software updates

Under **Settings → Software Update**, you can:

- Enable or disable automatic updates
- Enable or disable update reminders
- Check manually
- View download progress
- Restart to install a downloaded update
- Open Releases for a manual download

Update checks and downloads contact the update service. If GitHub is not directly reachable, configure an HTTP proxy such as `127.0.0.1:7890` and click **Test**.

### About

About shows the version, license, author, and open-source dependencies. Third-party model licenses are listed in [THIRD_PARTY_MODEL_NOTICES.md](THIRD_PARTY_MODEL_NOTICES.md).

---

## Privacy, network, and diagnostics

### Local processing boundary

Photo scanning, thumbnail generation, EXIF, AI vectors, face features, and search processing run locally by default. The app does not automatically upload photo content.

### When network access may occur

- Automatic updates or a manual update check
- Model recovery after a missing or failed verification
- A user-initiated upload or share to WebDAV/S3
- A user opening GitHub feedback and attaching a diagnostic bundle

### Create a diagnostic bundle

When something goes wrong, open **Settings → Help & Diagnostics**:

1. Describe the last action before the problem and what happened.
2. Choose how often it occurs.
3. Review the collection and privacy explanation.
4. Generate the redacted bundle; select a native crash dump only when it is necessary.
5. Export the ZIP, inspect it, and decide whether to attach it to a GitHub Issue.

A diagnostic bundle may include the app version, Windows/hardware summary, feature state, and redacted recent logs. It does not automatically include photos, databases, EXIF, face/vector data, search terms, or cloud credentials. It leaves the device only when the user exports or submits it.

---

## Keyboard shortcuts

Press `?` to open the in-app shortcut help panel.

### Browsing

| Shortcut | Action |
| --- | --- |
| `Space` | Quick preview selected photo |
| `←` / `→` | Navigate in preview or lightbox |
| `↑` / `↓` | Navigate in the detail panel |
| `Esc` | Close preview, lightbox, or panel |
| Double-click | Open lightbox |

### Selection and actions

| Shortcut | Action |
| --- | --- |
| Click | Select a photo |
| `Ctrl` + click | Toggle multi-selection |
| `Shift` + click | Range select |
| `Ctrl + A` | Select all |
| `F` | Toggle favorite |
| `Delete` | Delete selected photos |
| `F2` | Batch rename |
| `Ctrl + Shift + E` | Export |
| `Ctrl + Shift + C` | Convert format |

### Interface

| Shortcut | Action |
| --- | --- |
| `I` | Toggle the detail panel |
| `[` | Collapse or expand the sidebar |
| `Ctrl + K` | Global search |
| `?` | Shortcut help |

### Culling

| Shortcut | PK / Duel | Curate |
| --- | --- | --- |
| `←` | Pick left | Reject |
| `→` | Pick right | Keep |
| `Space` / `↓` | Skip | Reject |
| `D` | Draw | — |
| `S` | — | Skip similar |
| `Ctrl + Z` | Undo | Undo |
| `+` / `-` | Zoom in/out | Zoom in/out |
| `0` | Fit to screen | Fit to screen |

### Lightbox

| Shortcut | Action |
| --- | --- |
| `Space` | Play/pause slideshow |
| `Esc` | Exit lightbox |
| `I` | Toggle details |
| `F` | Toggle favorite |
| `T` | Toggle thumbnails |
| `R` | Rotate 90° clockwise |
| `Shift + R` | Rotate 90° counter-clockwise |
| `0` / `1` | Fit window / actual pixels |

---

## FAQ

### Why are there no search results?

Check the search mode and active filters. Semantic and image search require AI indexing; wait while the sidebar shows processing or continue indexing. Use filename, tag, people, and EXIF filters to verify that the library itself was imported.

### Do I need to download the AI models?

The normal release package includes the models required by the current version. A missing, corrupted, or failed-verification model may trigger a recovery download, which requires network access. If it continues to fail, reinstall and check security-software quarantine logs.

### What happens if a photo is moved?

The app cannot reliably follow every external move. The old record may become invalid. Clean invalid records under **Settings → Storage/Indexing**, then add the new folder.

### Where are the database and thumbnails?

Open **Settings → Storage/Data Directory**. Confirm free space before migration and do not close the app during migration.

### What if people grouping is inaccurate?

Name, merge, hide, or remove incorrect photos from the People page, then use **Recluster** if needed. Lighting, angle, occlusion, face size, and image quality affect results; recognition should be reviewed by a person.

### How can I speed up face recognition or AI indexing?

Detect and enable DirectML in Settings, then restart the indexing task. GPU acceleration depends on supported hardware and task type, and falls back to CPU on failure. SSD storage and additional memory help with large libraries; avoid running several heavy tasks at once.

### Why did duplicate detection find nothing?

Run the basic scan for exact duplicates. Visual-identical and visually-similar groups require perceptual or AI processing. Confirm the selected folder range and wait for AI indexing where necessary.

### Can I delete visually similar photos automatically?

Do not treat visual similarity as proof. Review the group, compare EXIF, sharpness, and intended use, choose a keeper, and then move only confirmed items to trash.

### How long do photos stay in trash?

The app trash keeps them for 30 days, then moves them to the Windows system recycle bin. Recovery after manual cleanup depends on the system recycle bin and subsequent actions.

### Why does the app connect to the network?

Typical causes are automatic updates, manual update checks, model recovery, user-initiated WebDAV/S3 uploads, or user-initiated diagnostic submission. Photo indexing and AI inference run locally by default.

### What should I do if an AI Worker cannot process photos?

1. Open **Settings → Help & Diagnostics** and create a redacted bundle.
2. Confirm that Visual C++ 2015–2022 x64 Redistributable is installed.
3. Check whether antivirus software quarantined `.dll`, `.node`, or ONNX files.
4. Re-detect the GPU and retry with GPU acceleration disabled if needed.
5. If using the portable build, try a short path without special characters.
6. Reinstall v2.0.0 and inspect the diagnostic bundle before filing an Issue.

### How do I report a problem?

Use **Settings → Help & Diagnostics**, inspect the redacted bundle, and submit it through [GitHub Issues](https://github.com/Uyoung666/ai-image-manager/issues). Do not publish cloud passwords, access keys, private photos, or GPS data in Issues, screenshots, or logs.

---

## Links

- [Project](https://github.com/Uyoung666/ai-image-manager)
- [Releases and downloads](https://github.com/Uyoung666/ai-image-manager/releases)
- [中文使用指南](GUIDE.md)
- [Third-party model notices](THIRD_PARTY_MODEL_NOTICES.md)
- [License](LICENSE)
