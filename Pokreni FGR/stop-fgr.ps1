[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$Runtime = Join-Path $Root ".fgr-runtime"
$Targets = @(
  @{ Name = "static"; Pattern = "http\.server\s+4173" },
  @{ Name = "processing"; Pattern = "processing_service\.py.*--port\s+8765" }
)
$Stopped = 0

try {
  foreach ($target in $Targets) {
    $pidPath = Join-Path $Runtime "$($target.Name).pid"
    if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf)) { continue }

    $pidText = (Get-Content -LiteralPath $pidPath -Raw).Trim()
    $processId = 0
    if ([int]::TryParse($pidText, [ref]$processId)) {
      $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
      if ($process -and [string]$process.CommandLine -match $target.Pattern) {
        Stop-Process -Id $processId -Force
        $Stopped += 1
      }
    }
    Remove-Item -LiteralPath $pidPath -Force
  }

  if ($Stopped -gt 0) {
    Write-Host "Zaustavljeno FGR servisa: $Stopped"
  } else {
    Write-Host "Nema FGR servisa koje je ovaj pokretac podigao."
  }
  exit 0
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
