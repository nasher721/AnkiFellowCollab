param(
    [Parameter(Mandatory = $true)]
    [string]$BackupPath,
    [string]$ProjectId = "anki-collab"
)

$ErrorActionPreference = "Stop"

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($Arguments -join ' ')"
    }
}

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
Invoke-NativeCommand docker exec $storageContainer find /var/lib/storage -mindepth 1 -exec rm -rf "{}" "+"
Invoke-NativeCommand docker cp "$storagePath/." "${storageContainer}:/var/lib/storage"

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
