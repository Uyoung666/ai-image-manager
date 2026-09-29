# AI Image Manager v2.2.1

## Highlights

- GitHub Releases is now the long-term distribution source for Windows releases.
- Setup and MSI installations keep in-app updates, preferring a verified delta package and falling back to the full package once when necessary.
- ZIP packages and MSI installations without the updater remain manual-install paths.
- The updater verifies fixed release URLs, package size, SHA1, and SHA256 before handing a package to Squirrel.Windows.

## Network and migration notes

- Updates require access to `api.github.com`, `github.com`, and the GitHub asset download host used after redirects.
- The updater follows Windows system proxy settings; a browser-only proxy does not automatically apply.
- Existing COS clients remain in a 30-day transition period after the formal v2.2.1 publication. No telemetry claim is made about migration completion.
- User data, the database, thumbnails, vector indexes, and local models remain in their existing data directory during an upgrade.
