function Invoke-NativeCommand {
    if ($args.Count -lt 1) {
        throw "Invoke-NativeCommand requires a command path"
    }
    $FilePath = [string]$args[0]
    $Arguments = @()
    if ($args.Count -gt 1) {
        $Arguments = @($args[1..($args.Count - 1)])
    }

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($Arguments -join ' ')"
    }
}
