param(
  [Parameter(Mandatory = $true)][string]$InstallDirectory,
  [Parameter(Mandatory = $true)][string]$UserDataDirectory,
  [Parameter(Mandatory = $true)][string]$Archive,
  [Parameter(Mandatory = $true)][string]$BackupRoot,
  [switch]$BackupOnly
)

$ErrorActionPreference = 'Stop'
$install = (Resolve-Path -LiteralPath $InstallDirectory).Path
$userData = (Resolve-Path -LiteralPath $UserDataDirectory).Path
$newArchive = (Resolve-Path -LiteralPath $Archive).Path
$newUnpacked = "$newArchive.unpacked"
$resources = Join-Path $install 'resources'
$liveArchive = Join-Path $resources 'app.asar'
$liveUnpacked = "$liveArchive.unpacked"
$executable = Join-Path $install '微课堂.exe'

if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw '安装目录中找不到微课堂.exe，未进行部署。' }
if (-not (Test-Path -LiteralPath $liveArchive -PathType Leaf)) { throw '安装目录中找不到原 app.asar，未进行部署。' }
if (-not (Test-Path -LiteralPath $liveUnpacked -PathType Container)) { throw '找不到原 app.asar.unpacked，未进行部署。' }
if (-not (Test-Path -LiteralPath $newUnpacked -PathType Container)) { throw '新构建缺少 app.asar.unpacked，未进行部署。' }
if ((Get-Item -LiteralPath $newArchive).Length -lt 1000000) { throw '新 app.asar 文件过小，未进行部署。' }
if ([IO.Path]::GetFullPath($newArchive) -eq [IO.Path]::GetFullPath($liveArchive)) { throw '构建来源不能与安装文件相同。' }

function Assert-AppStopped {
  $running = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and ([string]$_.ExecutablePath).StartsWith($install + '\', [StringComparison]::OrdinalIgnoreCase)
  })
  if ($running.Count -gt 0) {
    throw '微课堂仍在运行。请正常退出后再部署；脚本不会结束进程或覆盖正在使用的程序。'
  }
}

Assert-AppStopped
$backup = Join-Path ([IO.Path]::GetFullPath($BackupRoot)) (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
New-Item -ItemType Directory -Path $backup -ErrorAction Stop | Out-Null
Copy-Item -LiteralPath $liveArchive -Destination (Join-Path $backup 'app.asar')
Copy-Item -LiteralPath $liveUnpacked -Destination (Join-Path $backup 'app.asar.unpacked') -Recurse
$data = Join-Path $userData 'data'
if (Test-Path -LiteralPath $data -PathType Container) {
  Copy-Item -LiteralPath $data -Destination (Join-Path $backup 'data') -Recurse
}

$manifest = [ordered]@{
  createdAt = [DateTimeOffset]::Now.ToString('o')
  installDirectory = $install
  userDataDirectory = $userData
  oldArchiveSha256 = (Get-FileHash -LiteralPath $liveArchive -Algorithm SHA256).Hash
  newArchiveSha256 = (Get-FileHash -LiteralPath $newArchive -Algorithm SHA256).Hash
  dataFiles = @(if (Test-Path -LiteralPath $data -PathType Container) {
    Get-ChildItem -LiteralPath $data -File -Recurse | ForEach-Object {
      @{ path = $_.FullName.Substring($data.Length + 1); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
    }
  })
}
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $backup 'manifest.json') -Encoding UTF8
if ($BackupOnly) {
  Write-Output "BACKUP=$backup"
  Write-Output 'BACKUP_ONLY=true; LIVE_APPLICATION_UNCHANGED=true'
  return
}

Assert-AppStopped
$stagedArchive = Join-Path $resources 'app.next.asar'
$stagedUnpacked = Join-Path $resources 'app.next.asar.unpacked'
if ((Test-Path -LiteralPath $stagedArchive) -or (Test-Path -LiteralPath $stagedUnpacked)) {
  throw "发现之前的部署暂存文件，未覆盖。完整备份已保存在 $backup"
}
Copy-Item -LiteralPath $newArchive -Destination $stagedArchive
Copy-Item -LiteralPath $newUnpacked -Destination $stagedUnpacked -Recurse
if ((Get-FileHash -LiteralPath $stagedArchive -Algorithm SHA256).Hash -ne $manifest.newArchiveSha256) {
  throw '暂存构建校验失败，原程序未改变。'
}

try {
  Assert-AppStopped
  Remove-Item -LiteralPath $liveArchive -Force
  Remove-Item -LiteralPath $liveUnpacked -Recurse -Force
  Move-Item -LiteralPath $stagedArchive -Destination $liveArchive
  Move-Item -LiteralPath $stagedUnpacked -Destination $liveUnpacked
} catch {
  Copy-Item -LiteralPath (Join-Path $backup 'app.asar') -Destination $liveArchive -Force
  if (Test-Path -LiteralPath $liveUnpacked) { Remove-Item -LiteralPath $liveUnpacked -Recurse -Force }
  Copy-Item -LiteralPath (Join-Path $backup 'app.asar.unpacked') -Destination $liveUnpacked -Recurse
  throw
}

Write-Output "DEPLOYED=$liveArchive"
Write-Output "BACKUP=$backup"
Write-Output '用户数据库未打开、未修改；正常启动新版时才执行升级。回滚时请关闭软件并恢复成对的旧程序与 data 备份。'
