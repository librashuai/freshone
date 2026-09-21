[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$RestartFresh
)

$ErrorActionPreference = 'Stop'
$PackageName = 'freshone'
$SourceRoot = $PSScriptRoot

function Get-FreshCommand {
    $command = Get-Command fresh.exe -ErrorAction SilentlyContinue
    if (-not $command) { $command = Get-Command fresh -ErrorAction SilentlyContinue }
    if (-not $command) {
        throw '未找到 fresh。请先执行：winget install sinelaw.fresh-editor'
    }
    return $command.Source
}

function Get-FreshPluginsDirectory([string]$FreshExe) {
    $output = (& $FreshExe --cmd config paths 2>&1 | Out-String)
    foreach ($line in ($output -split "`r?`n")) {
        if ($line -match '^\s*plugins/\s*:\s*(.+?)\s*$') {
            return $Matches[1].Trim()
        }
    }
    # Fresh's Windows default. The CLI lookup above is preferred because it
    # also handles a custom config directory.
    if ($env:APPDATA) {
        return Join-Path $env:APPDATA 'fresh\plugins'
    }
    throw "无法从 'fresh --cmd config paths' 确定插件目录。输出：`n$output"
}

function Restart-FreshEditor([string]$FreshExe) {
    $running = @(Get-Process fresh -ErrorAction SilentlyContinue)
    if ($running.Count -eq 0) {
        Start-Process -FilePath $FreshExe -ArgumentList @('.') -WorkingDirectory (Get-Location).Path
        return
    }

    # Fresh has hot-exit/session restore, but stopping an editor is still an
    # explicit opt-in because it interrupts terminals and running tools.
    $running | Stop-Process -Force
    Start-Sleep -Milliseconds 500
    Start-Process -FilePath $FreshExe -ArgumentList @('.') -WorkingDirectory (Get-Location).Path
}

$fresh = Get-FreshCommand
$versionText = (& $fresh --version 2>&1 | Out-String).Trim()
if ($versionText -notmatch '(\d+\.\d+\.\d+)') {
    throw "无法识别 Fresh 版本：$versionText"
}
$version = [version]$Matches[1]
if ($version -lt [version]'0.5.1') {
    throw "需要 Fresh >= 0.5.1，当前版本为 $version。请执行：winget upgrade sinelaw.fresh-editor"
}

$pluginsDir = Get-FreshPluginsDirectory $fresh
$packagesDir = Join-Path $pluginsDir 'packages'
$destination = Join-Path $packagesDir $PackageName

if ($Uninstall) {
    if (Test-Path -LiteralPath $destination) {
        Remove-Item -LiteralPath $destination -Recurse -Force
        Write-Host "已卸载：$destination" -ForegroundColor Green
    } else {
        Write-Host "插件尚未安装：$destination" -ForegroundColor Yellow
    }
    if ($RestartFresh) { Restart-FreshEditor $fresh }
    exit 0
}

$requiredFiles = @(
    'package.json',
    'lsp_find_references_pinned.ts'
)
foreach ($file in $requiredFiles) {
    $path = Join-Path $SourceRoot $file
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "缺少部署文件：$path"
    }
}

Write-Host '检查插件 TypeScript…'
& $fresh --cmd script check (Join-Path $SourceRoot 'lsp_find_references_pinned.ts')
if ($LASTEXITCODE -ne 0) {
    throw 'Fresh 插件检查失败，未部署。'
}

New-Item -ItemType Directory -Path $packagesDir -Force | Out-Null
$transactionId = [Guid]::NewGuid().ToString('N')
$staging = Join-Path $packagesDir ('.freshone-staging-' + $transactionId)
$backup = Join-Path $packagesDir ('.freshone-backup-' + $transactionId)
New-Item -ItemType Directory -Path $staging -Force | Out-Null
try {
    foreach ($file in @('package.json', 'lsp_find_references_pinned.ts', 'README.md', 'LICENSE')) {
        $source = Join-Path $SourceRoot $file
        if (Test-Path -LiteralPath $source -PathType Leaf) {
            Copy-Item -LiteralPath $source -Destination (Join-Path $staging $file) -Force
        }
    }
    if (Test-Path -LiteralPath $destination) {
        Move-Item -LiteralPath $destination -Destination $backup
    }
    try {
        Move-Item -LiteralPath $staging -Destination $destination
    } catch {
        if ((Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $destination)) {
            Move-Item -LiteralPath $backup -Destination $destination
        }
        throw
    }
    if (Test-Path -LiteralPath $backup) {
        Remove-Item -LiteralPath $backup -Recurse -Force
    }
} finally {
    if (Test-Path -LiteralPath $staging) {
        Remove-Item -LiteralPath $staging -Recurse -Force
    }
}

Write-Host "已部署 Fresh $version 插件：$destination" -ForegroundColor Green
if ($RestartFresh) {
    Restart-FreshEditor $fresh
    Write-Host 'Fresh 已重启，插件已生效。' -ForegroundColor Green
} elseif (Get-Process fresh -ErrorAction SilentlyContinue) {
    Write-Host 'Fresh 正在运行；请重启 Fresh 使插件生效，或用 -RestartFresh 自动重启。' -ForegroundColor Yellow
} else {
    Write-Host '下次启动 Fresh 时插件将自动加载。'
}
