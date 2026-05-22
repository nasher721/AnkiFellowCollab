param(
    [string]$ProjectId = "anki-collab",
    [string]$Destination = ".deckbridge-backups",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "native-command.ps1")
. (Join-Path $PSScriptRoot "supabase-storage-path.ps1")

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDir = Join-Path $Destination "$ProjectId-$timestamp"
$absoluteBackupDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($backupDir)
$dbContainer = "supabase_db_$ProjectId"
$storageContainer = "supabase_storage_$ProjectId"
$postgresDump = Join-Path $backupDir "postgres.dump"
$storagePath = Join-Path $backupDir "storage"
$appStateArchive = Join-Path $backupDir "deckbridge-state.zip"
$restoreCommand = "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restore-local-server.ps1 -BackupPath `"$absoluteBackupDir`" -ProjectId `"$ProjectId`""

if ($DryRun) {
    Write-Host "Dry run only. No files will be written."
    Write-Host "Would create backup dir: $backupDir"
    Write-Host "Would dump Postgres from container: $dbContainer"
    Write-Host "Would copy storage from: ${storageContainer}:/var/lib/storage"
    if (Test-Path -LiteralPath ".deckbridge" -PathType Container) {
        Write-Host "Would archive app state: .deckbridge -> $appStateArchive"
    } else {
        Write-Host "Would archive app state: skipped; .deckbridge not present"
    }
    return
}

New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

Write-Host "Dumping Postgres from container: $dbContainer"
Invoke-NativeCommand docker exec $dbContainer pg_dump -U postgres -Fc -f /tmp/deckbridge-postgres.dump postgres
Invoke-NativeCommand docker cp "${dbContainer}:/tmp/deckbridge-postgres.dump" $postgresDump
Invoke-NativeCommand docker exec $dbContainer rm -f /tmp/deckbridge-postgres.dump

$containerStoragePath = Resolve-SupabaseStorageContainerPath -Container $storageContainer
Write-Host "Copying storage from: ${storageContainer}:$containerStoragePath"
Invoke-NativeCommand docker cp "${storageContainer}:$containerStoragePath" $storagePath

$manifestAppStateArchive = $null
if (Test-Path -LiteralPath ".deckbridge" -PathType Container) {
    Write-Host "Archiving app state: .deckbridge"
    Compress-Archive -LiteralPath ".deckbridge" -DestinationPath $appStateArchive -Force
    $manifestAppStateArchive = "deckbridge-state.zip"
}

$manifest = [ordered]@{
    createdAt = (Get-Date).ToUniversalTime().ToString("o")
    projectId = $ProjectId
    postgresDump = "postgres.dump"
    storagePath = "storage"
    appStateArchive = $manifestAppStateArchive
    restoreCommand = $restoreCommand
}

$manifest | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $backupDir "manifest.json") -Encoding UTF8

Write-Host "Backup complete: $backupDir"
