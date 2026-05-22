param(
  [string]$EnvFile = ".env.local-server"
)

$ErrorActionPreference = "Stop"
$path = (Resolve-Path -LiteralPath $EnvFile).Path
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$acl = [System.IO.File]::GetAccessControl($path, [System.Security.AccessControl.AccessControlSections]::Access)

$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) {
  [void]$acl.RemoveAccessRule($rule)
}

$rights = [System.Security.AccessControl.FileSystemRights]::FullControl
$inheritance = [System.Security.AccessControl.InheritanceFlags]::None
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow

foreach ($identity in @($currentUser, "BUILTIN\Administrators", "NT AUTHORITY\SYSTEM")) {
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, $rights, $inheritance, $propagation, $allow)
  $acl.AddAccessRule($rule)
}

[System.IO.File]::SetAccessControl($path, $acl)

$verified = [System.IO.File]::GetAccessControl($path, [System.Security.AccessControl.AccessControlSections]::Access)
$intendedIdentities = @($currentUser, "BUILTIN\Administrators", "NT AUTHORITY\SYSTEM")
$blocked = $verified.Access | Where-Object {
  $_.IdentityReference.Value -match "Everyone|Authenticated Users|BUILTIN\\Users"
}
$unexpected = $verified.Access | Where-Object {
  $_.IdentityReference.Value -notin $intendedIdentities
}

if ($blocked) {
  throw "Secret file still grants access to broad principals: $($blocked.IdentityReference.Value -join ', ')"
}

if ($unexpected) {
  throw "Secret file still grants access to unexpected principals: $($unexpected.IdentityReference.Value -join ', ')"
}

Write-Host "Locked $path to $currentUser, Administrators, and SYSTEM."
