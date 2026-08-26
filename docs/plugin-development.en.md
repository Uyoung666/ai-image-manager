# Plugin development guide (v2)

Public AI Image Manager plugins are read-only, declarative theme packages. They cannot run code, read host files, or initiate network requests. Authors provide JSON and optional media assets; the application interprets the theme inside its own safety boundary.

## Security boundary

A public package may contain only `plugin.json`, `theme.json`, and image/video files below `assets/`. JavaScript, HTML, CSS, fonts, executables, network URLs, `data:` URLs, and script-injection syntax are not part of the public API. On import, the application re-checks ZIP paths, duplicate entries, symlinks, asset extensions, media MIME, extraction limits, and theme bindings. CLI validation is a developer aid, not a replacement for the host's final validation.

Never ship a user's private image, credential, or absolute path. An `image`/`video` setting means “let the user choose a resource in the app”; it does not copy the user's file into the plugin. Bind such settings with `{"setting":"id"}`.

## Package layout

```text
my-plugin/
├── plugin.json
├── theme.json
└── assets/
    ├── optional-wallpaper.png
    └── optional-loop.webm
```

The root may contain only the two JSON files. `assets/` may be empty or contain nested directories. Supported asset extensions are `.png`, `.jpg`, `.jpeg`, `.webp`, `.avif`, `.gif`, `.mp4`, and `.webm`. Do not put READMEs, source files, or build output in the `.aim-plugin`; keep that material in the plugin repository or release page.

## Manifest fields

`plugin.json` uses these fixed v2 fields:

```json
{
  "manifestVersion": 2,
  "apiVersion": 2,
  "id": "com.example.layered-aurora",
  "version": "1.0.0",
  "name": { "en": "Layered Aurora", "zh": "分层极光" },
  "description": { "en": "A declarative theme.", "zh": "声明式主题。" },
  "author": { "name": "Example Studio", "url": "https://example.com" },
  "engine": { "minAppVersion": "2.0.0" },
  "capabilities": ["theme"],
  "themeFile": "theme.json",
  "settingGroups": [],
  "settings": []
}
```

- `id` is a lower-case reverse-domain identifier such as `com.example.layered-aurora`; it becomes part of the installed path.
- `version` and `engine.minAppVersion` are SemVer. A release may include valid prerelease/build metadata. Increment the package version for a new release; do not overwrite an installed version.
- `name` and `description` provide both `en` and `zh` strings; `author` is `{name,url?}`, and any URL must be an HTTP(S) URL without credentials.
- `capabilities` must currently be exactly `["theme"]`; `themeFile` must be exactly `theme.json`.
- `settingGroups` is a list (it may be empty) with unique `id` and bilingual `label`; settings reference a group with `group`. Groups and settings may declare `order`.
- A manifest has at most 64 settings and a theme has at most four layers. Layer types are `solid`, `linearGradient`, `radialGradient`, `image`, `video`, and `aurora`.

## Settings, groups, and conditions

Settings support `boolean`, `number`, `select`, `color`, `image`, and `video`. Each setting has an `id`, `type`, bilingual `label`, and a type-matching `defaultValue`. Numbers may declare `min`, `max`, and `step`; selects require labelled `options`; image and video defaults must be `null`.

```json
{
  "id": "auroraIntensity",
  "type": "number",
  "label": { "en": "Aurora intensity", "zh": "极光强度" },
  "defaultValue": 0.7,
  "min": 0,
  "max": 1,
  "step": 0.05,
  "group": "effects",
  "visibleWhen": { "setting": "showAurora", "equals": true }
}
```

`visibleWhen` may reference only a declared setting, and the comparison value must have the same type: booleans compare booleans, numbers compare finite numbers, selects compare declared options, colors compare safe colors, and image/video settings compare `null` or string values. Use `equals`, `notEquals`, `value` (an `equals` alias), or `in` (a non-empty array with no duplicates). Arbitrary expressions, self-references, and cycles are not allowed.

Theme properties use strongly typed binding objects. `{ "setting": "accentColor" }` may target only a `color` setting, `{ "setting": "auroraIntensity" }` only a `number` setting, an image layer's `asset` only an `image` setting, and a video layer only a `video` setting. Unknown setting IDs and mismatched types are rejected. Use a binding for user-selected media instead of an absolute path.

## Themes and layered Aurora

`theme.json` contains at most four layers, and every layer has a unique `id`. Layer types are `solid`, `linearGradient`, `radialGradient`, `image`, `video`, and `aurora`:

```json
{
  "layers": [
    { "id": "base", "type": "solid", "color": "#07111f" },
    {
      "id": "gradient",
      "type": "linearGradient",
      "angle": 132,
      "stops": [
        { "color": { "setting": "accentColor" }, "offset": 0 },
        { "color": "#312e81", "offset": 1 }
      ]
    },
    {
      "id": "aurora",
      "type": "aurora",
      "colors": ["#22d3ee", { "setting": "accentColor" }, "#a78bfa"],
      "intensity": { "setting": "auroraIntensity" }
    }
  ]
}
```

Gradient stop offsets are between `0` and `1`, with literal stops strictly increasing from `0` to `1`. v2 color literals are limited to `#RRGGBB` or `#RRGGBBAA`; short hex, `rgb()`, `hsl()`, and `url()` are rejected. Numeric layer properties such as `opacity`, `angle`, and `speed` may bind to a `number` setting; color properties may bind only to `color`. An `image`/`video` layer uses a safe relative `assets/...` path or a binding of the matching media type. Optional `material.kind` values are `none`, `solid`, `glass`, `mica`, and `acrylic`; `tokens` may use only the host's allow-listed color token names, and values may be safe color literals or color-setting bindings only—numeric/size tokens are not supported.

## Install, update, and uninstall semantics

- Import starts with a preflight view of identity, version relation, capabilities, compatibility, package size, and SHA-256. Installation happens only after confirmation. A new install is not enabled automatically and does not replace the active theme.
- An installed version cannot be overwritten, and release packages cannot downgrade. An update preserves settings, active state, and user media, while retaining the last successfully activated version for rollback.
- Images and videos selected through settings are copied into app-managed storage. The theme receives only an opaque host resource URL, never the original file path. Replacing, removing, or resetting media cleans up the corresponding managed copy.
- Uninstall defaults to deleting plugin settings and managed media. Clear that option to remove only package versions while retaining user data for a later reinstall. Package versions are removed in either case.

## Development workflow

1. Copy `examples/plugins/layered-aurora` as a minimal starting point and edit JSON first.
2. From the repository root, run `npm run plugin:validate -- <plugin-directory>`. It checks v2 fields, conditions, bindings, layer count, asset paths, and extra files.
3. In the app's Settings page, enable Developer mode, choose “Load developer directory”, then use “Refresh manually” to inspect changes. The directory is not copied into managed storage; the current workflow has no hot reload, so reload manually after edits.
4. Do not assume a restart automatically reloads a developer directory. If it is missing or stale after restart, use the Settings page's manual reload action again, conservatively following the capabilities of the current app build.
5. For release testing, validate and pack again, then import the `.aim-plugin` from the app's Settings page. If an older version is installed, uninstall it or increment `version` to avoid same-version conflicts.

Pack a plugin with:

```powershell
npm run plugin:pack -- examples/plugins/layered-aurora --out .\dist\plugins
```

The output is always named `<id>-<version>.aim-plugin`. The CLI validates before packing, then writes a deterministic ZIP with `plugin.json`, `theme.json`, and assets sorted by normalized path. Repacking unchanged source files produces the same bytes.

Validate an existing package directly:

```powershell
npm run plugin:validate -- .\dist\plugins\com.aiimagemanager.layered-aurora-1.0.0.aim-plugin
```

## Release checklist

- [ ] `manifestVersion`/`apiVersion` are `2`, `capabilities` is exactly `["theme"]`, and `themeFile` is `theme.json`.
- [ ] The ID is a lower-case reverse-domain ID, the version is a new valid SemVer, and the minimum app version is accurate.
- [ ] `en`/`zh` text is complete; setting types, defaults, ranges, options, and group references agree.
- [ ] Every `visibleWhen` reference exists, has the right value type, and is acyclic; every `{ "setting": "id" }` binding is strongly typed.
- [ ] There are no more than four uniquely identified layers; every asset is under `assets/` and its extension and actual MIME agree.
- [ ] There is no JS/HTML/CSS, network URL, absolute path, symlink, hidden build output, or extra file.
- [ ] Check the settings panel at `720×480`, `900×600`, and `1280×800`; test enable, disable, re-import, and uninstall.
- [ ] Run `npm run plugin:validate -- <directory>` and `npm run plugin:pack -- <directory> --out <output-directory>`, and keep the package and validation log.

## Troubleshooting

| Error | Fix |
| --- | --- |
| `manifestVersion and apiVersion must both be 2` | Set both fields to `2`; do not mix a v1 manifest with v2 tooling. |
| `id must be a reverse-domain id` | Use lower-case text with at least one dot, such as `org.example.my-theme`. |
| `themeFile must be "theme.json"` | Put the theme at the root and use the fixed filename. |
| `references unknown setting` | Check the spelling of a binding or `visibleWhen.setting`; declare settings before referring to them. |
| `binding must target ...` | Match the target type: color, number, image, and video bindings are not interchangeable. |
| `references missing asset` | Use a relative `assets/` path and make sure the file is included. |
| `contains an extra file` / `unsupported asset` | Remove READMEs, source files, and unsupported extensions; keep documentation in the repository. |
| `cannot contain symlinks` / `unsafe path` | Copy assets into the plugin directory; never use symlinks, `..`, absolute paths, or traversal backslashes. |
| Import reports an invalid plugin | Run the CLI again, verify media MIME and that no second ZIP tool rewrote the archive, then inspect the app's plugin log. |
