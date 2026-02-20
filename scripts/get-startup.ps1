$results = @()

# HKCU Run
try {
  $hkcuPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  if (Test-Path $hkcuPath) {
    $props = Get-ItemProperty -Path $hkcuPath -ErrorAction SilentlyContinue
    $props.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object {
      $results += [pscustomobject]@{
        Name = $_.Name
        Command = $_.Value
        Location = 'HKCU'
        RegistryPath = $hkcuPath
        Type = 'Registry'
      }
    }
  }
} catch {}

# HKLM Run
try {
  $hklmPath = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run'
  if (Test-Path $hklmPath) {
    $props = Get-ItemProperty -Path $hklmPath -ErrorAction SilentlyContinue
    $props.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object {
      $results += [pscustomobject]@{
        Name = $_.Name
        Command = $_.Value
        Location = 'HKLM'
        RegistryPath = $hklmPath
        Type = 'Registry'
      }
    }
  }
} catch {}

# Startup Folder (Current User)
try {
  $startupFolder = [System.Environment]::GetFolderPath('Startup')
  if (Test-Path $startupFolder) {
    Get-ChildItem $startupFolder -File | ForEach-Object {
      $results += [pscustomobject]@{
        Name = $_.BaseName
        Command = $_.FullName
        Location = 'StartupFolder'
        RegistryPath = $startupFolder
        Type = 'Shortcut'
      }
    }
  }
} catch {}

# Task Scheduler (login triggers only)
try {
  Get-ScheduledTask | Where-Object {
    $_.State -ne 'Disabled' -and
    $_.Triggers | Where-Object { $_ -is [CimInstance] -and $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' }
  } | Select-Object -First 20 | ForEach-Object {
    $action = ($_.Actions | Select-Object -First 1).Execute
    if ($action) {
      $results += [pscustomobject]@{
        Name = $_.TaskName
        Command = $action
        Location = 'TaskScheduler'
        RegistryPath = $_.TaskPath
        Type = 'Task'
      }
    }
  }
} catch {}

if ($results.Count -eq 0) {
  Write-Output '[]'
} else {
  $results | ConvertTo-Json -Depth 3
}
