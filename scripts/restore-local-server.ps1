param(
    [Parameter(Mandatory = $true)]
    [string]$BackupPath,
    [string]$ProjectId = "anki-collab"
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "native-command.ps1")
. (Join-Path $PSScriptRoot "supabase-storage-path.ps1")

$resolvedBackupPath = Resolve-Path -LiteralPath $BackupPath
$backupRoot = $resolvedBackupPath.Path
$postgresDump = Join-Path $backupRoot "postgres.dump"
$storagePath = Join-Path $backupRoot "storage"
$appStateArchive = Join-Path $backupRoot "deckbridge-state.zip"
$dbContainer = "supabase_db_$ProjectId"
$storageContainer = "supabase_storage_$ProjectId"

if (-not (Test-Path -LiteralPath $postgresDump -PathType Leaf)) {
    throw "Missing required backup file: $postgresDump"
}

if (-not (Test-Path -LiteralPath $storagePath -PathType Container)) {
    throw "Missing required backup directory: $storagePath"
}

Write-Host "Restoring Postgres into container: $dbContainer"
Invoke-NativeCommand docker cp $postgresDump "${dbContainer}:/tmp/deckbridge-postgres.dump"
Invoke-NativeCommand docker exec $dbContainer pg_restore -U postgres --clean --if-exists --no-owner -d postgres /tmp/deckbridge-postgres.dump
Invoke-NativeCommand docker exec $dbContainer rm -f /tmp/deckbridge-postgres.dump

Write-Host "Restoring storage into container: $storageContainer"
$containerStoragePath = Resolve-SupabaseStorageContainerPath -Container $storageContainer
Invoke-NativeCommand docker exec $storageContainer find $containerStoragePath -mindepth 1 -exec rm -rf "{}" "+"
Invoke-NativeCommand docker cp "$storagePath/." "${storageContainer}:$containerStoragePath"

if (Test-Path -LiteralPath $appStateArchive -PathType Leaf) {
    if (Test-Path -LiteralPath ".deckbridge" -PathType Container) {
        $stateBackupName = ".deckbridge.before-restore-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Write-Host "Renaming existing .deckbridge to: $stateBackupName"
        Rename-Item -LiteralPath ".deckbridge" -NewName $stateBackupName
    }

    Write-Host "Restoring app state archive: $appStateArchive"
    Expand-Archive -LiteralPath $appStateArchive -DestinationPath "." -Force
}

Write-Host "Restore complete: $backupRoot"
