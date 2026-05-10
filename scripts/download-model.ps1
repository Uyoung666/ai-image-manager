# CLIP 模型下载脚本
# 用途：预下载 CLIP ViT-B/32 量化模型到本地 models/ 目录
# 默认使用 hf-mirror.com 国内镜像，可通过 HF_MIRROR 环境变量覆盖

param(
    [string]$Mirror = $env:HF_MIRROR
)

if (-not $Mirror) {
    $Mirror = "hf-mirror.com"
}

$BaseUrl = "https://${Mirror}/Xenova/clip-vit-base-patch32/resolve/main"
$TargetDir = "$PSScriptRoot/../models/Xenova/clip-vit-base-patch32"
$OnnxDir = "$TargetDir/onnx"

Write-Host "=== CLIP 模型下载 ===" -ForegroundColor Cyan
Write-Host "镜像: $Mirror"
Write-Host "目标: $TargetDir"

New-Item -ItemType Directory -Force -Path $OnnxDir | Out-Null

$files = @(
    @{Name="config.json"; Size="~1KB"},
    @{Name="preprocessor_config.json"; Size="~1KB"},
    @{Name="tokenizer.json"; Size="~2.2MB"},
    @{Name="tokenizer_config.json"; Size="~1KB"},
    @{Name="onnx/model_quantized.onnx"; Size="~147MB"}
)

foreach ($file in $files) {
    $url = "$BaseUrl/$($file.Name)"
    $outPath = "$TargetDir/$($file.Name)"
    Write-Host "下载 $($file.Name) ($($file.Size))..." -NoNewline
    try {
        Invoke-WebRequest -Uri $url -OutFile $outPath -TimeoutSec 300 -ErrorAction Stop
        Write-Host " OK" -ForegroundColor Green
    } catch {
        Write-Host " FAILED: $_" -ForegroundColor Red
        exit 1
    }
}

Write-Host ""
Write-Host "=== 下载完成 ===" -ForegroundColor Green
$totalSize = (Get-ChildItem -Path $TargetDir -Recurse | Measure-Object -Property Length -Sum).Sum
Write-Host "总大小: $([math]::Round($totalSize / 1MB, 1)) MB"
Write-Host ""
Write-Host "模型已就绪，运行 npm run dev 启动应用。" -ForegroundColor Yellow
