function Resolve-SupabaseStorageContainerPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Container,
        [scriptblock]$PathExists = {
            param([string]$ContainerName, [string]$ContainerPath)
            docker exec $ContainerName test -d $ContainerPath | Out-Null
            return $LASTEXITCODE -eq 0
        }
    )

    foreach ($candidate in @("/var/lib/storage", "/mnt")) {
        if (& $PathExists $Container $candidate) {
            return $candidate
        }
    }

    throw "Could not find Supabase storage data directory in container: $Container"
}
