# Plugin development guide (v2 themes and v3 locales)

Public AI Image Manager plugins are read-only, declarative theme or locale packages. They cannot run code, read host files, or initiate network requests. Authors provide JSON and optional media assets for themes; the application interprets both capabilities inside its own safety boundary.

## Security boundary

A v2 theme package may contain only `plugin.json`, `theme.json`, and image/video files below `assets/`. A v3 locale package may contain only `plugin.json`, `signature.json`, and `locales/<tag>/renderer.json` plus `locales/<tag>/main.json`. JavaScript, HTML, CSS, fonts, executables, network URLs, `data:` URLs, and script-injection syntax are not part of the public API. On import, the application re-checks ZIP paths, duplicate entries, symlinks, asset extensions, media MIME, extraction limits, locale structure, and signatures. CLI validation is a developer aid, not a replacement for the host's final validation.

Release v3 locale packages must verify against the official Ed25519 keyring injected by the application build. The source default trusts no temporary public key. A release build should keep its public keys in an audited, versioned module and pass that map to `configurePluginManager(builtins, keyring)` (optionally after `createPluginTrustedKeyring(keyring)` validates and freezes it); never read a runtime environment variable or plugin directory as a trust anchor. Because the source default keyring is empty, a build that does not inject the release keyring rejects every release locale package. A developer directory may omit the signature, but is loaded only in developer mode and is always marked with `developer` trust.

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

A v3 locale package uses this fixed layout (one canonical BCP 47 locale per package):

```text
my-locale/
├── plugin.json
├── signature.json
└── locales/
    └── ja-JP/
        ├── renderer.json
        └── main.json
```

A theme package root may contain only `plugin.json` and `theme.json`; `assets/` may be empty or contain nested directories. A locale package root may contain only `plugin.json` and `signature.json`, with resources fixed below `locales/<tag>/`. Theme assets support `.png`, `.jpg`, `.jpeg`, `.webp`, `.avif`, `.gif`, `.mp4`, and `.webm`. Do not put READMEs, source files, or build output in the `.aim-plugin`; keep that material in the plugin repository or release page.

## Manifest fields

Theme packages use these fixed v2 fields in `plugin.json`:

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

Locale packages use a separate v3 manifest and must not include theme fields:

```json
{
  "manifestVersion": 3,
  "apiVersion": 3,
  "id": "com.example.japanese-locale",
  "version": "1.0.0",
  "name": { "en": "Japanese", "ja-JP": "日本語" },
  "description": { "en": "Japanese UI translation.", "ja-JP": "日本語 UI 翻訳。" },
  "author": { "name": "Example Studio" },
  "engine": { "minAppVersion": "2.0.0" },
  "capabilities": ["locale"],
  "locale": {
    "tag": "ja-JP",
    "nativeName": "日本語",
    "fallback": "en",
    "direction": "ltr",
    "catalogVersion": "1.0.0",
    "rendererFile": "locales/ja-JP/renderer.json",
    "mainFile": "locales/ja-JP/main.json"
  }
}
```

In v3, `name` and `description` are locale maps keyed by canonical BCP 47 tags and must include both `en` and the target tag. `fallback` is fixed to `en`, and the first release supports only `ltr`. Both resource files may contain only objects, arrays, and strings; strings may not contain HTML, script URLs, or dangerous control characters. Locale packages do not provide settings, themes, icons, or media assets.

`signature.json` has the shape `{ "algorithm": "ed25519", "keyId": "release-1", "signature": "<base64>" }`. The signed bytes are a whitespace-free JSON array of every file except `signature.json`, sorted by normalized `/` path. Each item uses the exact `path`, `size`, `sha256` key order; `sha256` is the lower-case SHA-256 of the file bytes. Signing keys are read only from an explicit CLI path or an external environment-variable path and are never written into the plugin or app storage; the environment-variable form is for the CLI release machine only, never for the app runtime keyring.

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
- A v3 preflight also shows the locale, signature status, signer key ID, and available coverage information. A release `.aim-plugin` without an official signature is rejected. Locale packages are activated through language settings, not the theme plugin toggle.
- An installed version cannot be overwritten, and release packages cannot downgrade. An update preserves settings, active state, and user media, while retaining the last successfully activated version for rollback.
- Images and videos selected through settings are copied into app-managed storage. The theme receives only an opaque host resource URL, never the original file path. Replacing, removing, or resetting media cleans up the corresponding managed copy.
- Uninstall defaults to deleting plugin settings and managed media. Clear that option to remove only package versions while retaining user data for a later reinstall. Package versions are removed in either case.

## Development workflow

1. Copy `examples/plugins/layered-aurora` as a minimal starting point and edit JSON first.
2. From the repository root, run `npm run plugin:validate -- <plugin-directory>`. It checks v2 fields, conditions, bindings, layer count, asset paths, and extra files.
3. In the app's Settings page, enable Developer mode, choose “Load developer directory”, then use “Refresh manually” to inspect changes. The directory is not copied into managed storage; the current workflow has no hot reload, so reload manually after edits.
4. Do not assume a restart automatically reloads a developer directory. If it is missing or stale after restart, use the Settings page's manual reload action again, conservatively following the capabilities of the current app build.
5. For release testing, validate and pack again, then import the `.aim-plugin` from the app's Settings page. If an older version is installed, uninstall it or increment `version` to avoid same-version conflicts.

The same `validate` command checks locale directories for the v3 manifest, BCP 47 tag, fixed resource paths, JSON structure, extra files, and signature shape. Whether a signer is in the official keyring and whether the signature matches the files are still checked by the host during import. Sign a release by reading an Ed25519 private key from an external file:

Pack a plugin with:

```powershell
npm run plugin:pack -- examples/plugins/layered-aurora --out .\dist\plugins

# v3 locale: --sign-key accepts only a private-key file path; --key-id is metadata
node scripts/plugin-cli.mjs pack <locale-directory> --out .\dist\plugins --sign-key <private-key-file> --key-id <release-key-id>
```

The output is always named `<id>-<version>.aim-plugin`. The CLI validates before packing, then writes a deterministic ZIP (`plugin.json`, `theme.json`, and assets for themes; `plugin.json`, `signature.json`, and locale files for locales), with normalized paths sorted deterministically. Repacking unchanged source files and signing inputs produces the same bytes.

Validate an existing package directly:

```powershell
npm run plugin:validate -- .\dist\plugins\com.aiimagemanager.layered-aurora-1.0.0.aim-plugin
```

## Release checklist

- [ ] A v2 theme package has `manifestVersion`/`apiVersion` `2`, `capabilities` exactly `["theme"]`, and `themeFile` `theme.json`; or a v3 locale package has both version fields `3` and `capabilities` exactly `["locale"]`.
- [ ] A v3 locale package contains one canonical BCP 47 tag, `fallback` `en`, `direction` `ltr`, the fixed renderer/main JSON files, and an official Ed25519 signature.
- [ ] The ID is a lower-case reverse-domain ID, the version is a new valid SemVer, and the minimum app version is accurate.
- [ ] Theme `en`/`zh` text is complete; setting types, defaults, ranges, options, and group references agree. Locale `name`/`description` include both `en` and the target tag.
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
| `locale package must contain signature.json` / `signature` | Repack the release with an external Ed25519 private key and ensure its key ID is in the release keyring. |
| `locale bundle ...` | Locale resources may contain only objects, arrays, and strings; remove HTML, script URLs, control characters, or oversized content. |
| `references unknown setting` | Check the spelling of a binding or `visibleWhen.setting`; declare settings before referring to them. |
| `binding must target ...` | Match the target type: color, number, image, and video bindings are not interchangeable. |
| `references missing asset` | Use a relative `assets/` path and make sure the file is included. |
| `contains an extra file` / `unsupported asset` | Remove READMEs, source files, and unsupported extensions; keep documentation in the repository. |
| `cannot contain symlinks` / `unsafe path` | Copy assets into the plugin directory; never use symlinks, `..`, absolute paths, or traversal backslashes. |
| Import reports an invalid plugin | Run the CLI again, verify media MIME and that no second ZIP tool rewrote the archive, then inspect the app's plugin log. |
