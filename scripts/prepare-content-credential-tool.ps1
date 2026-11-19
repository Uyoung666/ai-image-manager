$ErrorActionPreference = "Stop"

$version = "0.29.0"
$trustCommit = "733890ff613484f1d4a22f6d70606f96d2418cf0"
$project = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $project ".test-runtime"
$scratch = Join-Path $runtime ("content-credential-download-" + [guid]::NewGuid())
$destination = Join-Path $runtime "content-credential-tool"
$archive = Join-Path $scratch "tool.zip"
$trust = Join-Path $scratch "c2pa-trust-list.pem"

function Get-VerifiedFile($Url, $Destination, $ExpectedHash) {
  Invoke-WebRequest -Uri $Url -OutFile $Destination
  if ((Get-FileHash -LiteralPath $Destination).Hash -ne $ExpectedHash) {
    throw "SHA-256 mismatch for $Url"
  }
}

New-Item -ItemType Directory -Path $scratch -Force | Out-Null
try {
  Get-VerifiedFile `
    "https://github.com/contentauth/c2patool/releases/download/v$version/v$version-x86_64-pc-windows-msvc.zip" `
    $archive "CC36C274A9A2CFC20F356D5D5C7F8B2C01E906E6550A45018D7FCA0158CF5B8A"
  Get-VerifiedFile `
    "https://raw.githubusercontent.com/c2pa-org/conformance-public/$trustCommit/trust-list/C2PA-TRUST-LIST.pem" `
    $trust "148C1C167E98DC909A0D5793D2FEEE1022AA60FEF5C83A0D6B08F67F4446BC37"
  Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $scratch "expanded")
  $exe = Join-Path $scratch "expanded/c2patool/c2patool.exe"
  $license = Join-Path $scratch "LICENSE-MIT"
  Invoke-WebRequest -Uri "https://raw.githubusercontent.com/contentauth/c2patool/v$version/LICENSE-MIT" -OutFile $license
  New-Item -ItemType Directory -Path $destination -Force | Out-Null
  Copy-Item -LiteralPath $trust, $exe, $license -Destination $destination -Force
  @'
[core]
allowed_network_hosts = []
allow_redirects = false

[verify]
verify_after_reading = true
remote_manifest_fetch = false
ocsp_fetch = false
ocsp_fetch_should_override = false
verify_trust = true
'@ | Set-Content -LiteralPath (Join-Path $destination "c2pa.toml") -Encoding ascii
  Write-Output "Prepared c2patool $version in $destination"
}
finally {
  $resolvedRuntime = (Resolve-Path -LiteralPath $runtime).Path
  $resolvedScratch = (Resolve-Path -LiteralPath $scratch).Path
  if ([IO.Path]::GetDirectoryName($resolvedScratch) -eq $resolvedRuntime) {
    Remove-Item -LiteralPath $resolvedScratch -Recurse -Force
  }
}
