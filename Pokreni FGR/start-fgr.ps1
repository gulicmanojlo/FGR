[CmdletBinding()]
param(
  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
$Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$Python = Join-Path $Root ".venv\Scripts\python.exe"
$Runtime = Join-Path $Root ".fgr-runtime"
$AppUrl = "http://127.0.0.1:4173/?core=147"
$StartedProcesses = @()

function Test-LocalPort {
  param([int]$Port)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $connect = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    if (-not $connect.AsyncWaitHandle.WaitOne(300)) { return $false }
    $client.EndConnect($connect)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Wait-LocalPort {
  param([int]$Port, [int]$Seconds = 25)
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-LocalPort -Port $Port) { return }
    Start-Sleep -Milliseconds 200
  }
  throw "Servis na portu $Port se nije pokrenuo u roku od $Seconds sekundi."
}

function Test-FgrApp {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://127.0.0.1:4173/"
    return $response.StatusCode -eq 200 -and $response.Content -match "FGR" -and $response.Content -match "ui-controller.js"
  } catch {
    return $false
  }
}

function Test-FgrProcessingService {
  $response = $null
  try {
    $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:8765/v1/songs/launcher-probe/process")
    $request.Timeout = 3000
    $response = $request.GetResponse()
  } catch [System.Net.WebException] {
    $response = $_.Exception.Response
  }
  if ($null -eq $response) { return $false }
  try {
    $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
    try { $body = $reader.ReadToEnd() } finally { $reader.Dispose() }
    return $body -match '"song_not_found"'
  } finally {
    $response.Dispose()
  }
}

function Assert-FgrProcessingDependencies {
  $output = & $Python (Join-Path $Root "processing_service.py") "--check-dependencies" 2>&1 | Out-String
  $exitCode = $LASTEXITCODE
  if ($exitCode -eq 0) {
    Write-Host "AI audio zavisnosti su spremne (Demucs + librosa/pYIN + FFmpeg). Basic Pitch je opciona rezerva."
    return
  }

  $installCommand = "`"$Python`" -m pip install -r `"$(Join-Path $Root 'requirements-processing.txt')`""
  try {
    $status = $output | ConvertFrom-Json
    $missing = @($status.missing) -join ", "
    if ($missing -match "demucs") {
      throw "Demucs nije dostupan u FGR Python okruzenju. Pokreni: $installCommand"
    }
    if ($missing -match "ffmpeg") {
      throw "FFmpeg nije dostupan. Instaliraj FFmpeg i dodaj ffmpeg u PATH, pa ponovo pokreni FGR."
    }
    if ($missing -match "librosa|numpy") {
      throw "librosa/pYIN nije dostupan u FGR Python okruzenju. Pokreni: $installCommand"
    }
  } catch {
    if ($_.Exception.Message -match "^(Demucs|FFmpeg|librosa/pYIN)") { throw }
  }
  throw "AI audio provera nije uspela. Detalji: $output"
}

function Start-FgrProcess {
  param(
    [string[]]$Arguments,
    [string]$Name
  )
  $stdout = Join-Path $Runtime "$Name.out.log"
  $stderr = Join-Path $Runtime "$Name.err.log"
  $process = Start-Process `
    -FilePath $Python `
    -ArgumentList $Arguments `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -PassThru
  [System.IO.File]::WriteAllText((Join-Path $Runtime "$Name.pid"), [string]$process.Id)
  $script:StartedProcesses += $process
  return $process
}

try {
  if (-not (Test-Path -LiteralPath (Join-Path $Root "index.html") -PathType Leaf)) {
    throw "Glavni FGR index.html nije pronadjen u: $Root"
  }
  if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) {
    throw "Python okruzenje nije pronadjeno: $Python"
  }
  if (-not (Test-Path -LiteralPath $Runtime -PathType Container)) {
    New-Item -ItemType Directory -Path $Runtime | Out-Null
  }

  Assert-FgrProcessingDependencies

  if (Test-LocalPort -Port 4173) {
    if (-not (Test-FgrApp)) {
      throw "Port 4173 koristi druga aplikacija. Zatvori je pa ponovo pokreni FGR."
    }
    Write-Host "FGR web server vec radi na portu 4173."
  } else {
    Start-FgrProcess -Name "static" -Arguments @("-m", "http.server", "4173", "--bind", "127.0.0.1") | Out-Null
    Wait-LocalPort -Port 4173
    if (-not (Test-FgrApp)) { throw "FGR web server je pokrenut, ali index nije dostupan." }
    Write-Host "FGR web server je pokrenut."
  }

  if (Test-LocalPort -Port 8765) {
    if (-not (Test-FgrProcessingService)) {
      throw "Port 8765 koristi druga aplikacija. Zatvori je pa ponovo pokreni FGR."
    }
    Write-Host "FGR AI servis vec radi na portu 8765."
  } else {
    Start-FgrProcess -Name "processing" -Arguments @("processing_service.py", "--port", "8765", "--workers", "1", "--verbose") | Out-Null
    Wait-LocalPort -Port 8765
    if (-not (Test-FgrProcessingService)) { throw "FGR AI servis se nije pravilno odazvao." }
    Write-Host "FGR AI servis je pokrenut."
  }

  if (-not $NoOpen) {
    Write-Host "Otvaram FGR u podrazumevanom browseru..."
    Start-Process -FilePath $AppUrl
  } else {
    Write-Host "Provera je uspesna: $AppUrl"
  }
  exit 0
} catch {
  foreach ($process in $StartedProcesses) {
    if ($process -and -not $process.HasExited) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
  }
  Write-Error $_.Exception.Message
  Write-Host "Logovi su u folderu: $Runtime"
  exit 1
}
