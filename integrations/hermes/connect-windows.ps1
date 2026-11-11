[CmdletBinding(PositionalBinding = $false)]
param(
  [string]$EnvoiUrl = 'https://envoi-staging.rachelgonsalves821.workers.dev',
  [string]$StateDir = '',
  [switch]$PrepareOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$hermesHome = Join-Path $env:LOCALAPPDATA 'hermes'
$hermesExe = Join-Path $hermesHome 'bin\hermes.exe'
$hermesEnv = Join-Path $hermesHome '.env'
$hermesConfig = Join-Path $hermesHome 'config.yaml'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$bundle = Join-Path $PSScriptRoot 'dist\run.mjs'

if (-not (Test-Path -LiteralPath $hermesExe)) { throw 'Hermes Agent is not installed in the standard Windows location.' }
$origin = [Uri]$EnvoiUrl
if ($origin.Scheme -ne 'https' -or $origin.UserInfo -or $origin.Query -or $origin.Fragment -or $origin.AbsolutePath -ne '/') {
  throw 'EnvoiUrl must be an HTTPS site origin without credentials or a path.'
}
$stateRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Envoi\HermesBridge'))
if (-not $StateDir) { $StateDir = Join-Path $stateRoot $origin.Host }
if (-not [IO.Path]::IsPathFullyQualified($StateDir)) {
  throw 'StateDir must be an absolute path inside the private HermesBridge folder. Paste enrollment tokens only at the hidden-input prompt.'
}
$StateDir = [IO.Path]::GetFullPath($StateDir)
$relativeStateDir = [IO.Path]::GetRelativePath($stateRoot, $StateDir)
if ($relativeStateDir -eq '.' -or $relativeStateDir -eq '..' -or $relativeStateDir.StartsWith("..$([IO.Path]::DirectorySeparatorChar)") -or [IO.Path]::IsPathFullyQualified($relativeStateDir)) {
  throw 'StateDir must stay inside the private HermesBridge folder.'
}
$session = Join-Path $StateDir 'session.json'
if (-not $PrepareOnly) {
  $otherBridge = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop |
    Where-Object { $_.CommandLine -match 'integrations[\\/]hermes[\\/]dist[\\/]run\.mjs' }
  if ($otherBridge) { throw 'A Hermes Envoi bridge is already running. Stop its terminal with Ctrl+C, then run this command again to resume the same enrollment.' }
}

# This key authorizes the local bridge to call the local Hermes Gateway. It is
# never sent to Envoi or included in an agent prompt.
$lines = if (Test-Path -LiteralPath $hermesEnv) { [string[]][IO.File]::ReadAllLines($hermesEnv) } else { [string[]]@() }
$enabledIndexes = @()
$keyIndexes = @()
$relayIndexes = @()
for ($i = 0; $i -lt $lines.Length; $i++) {
  if ($lines[$i] -match '^[ \t]*API_SERVER_ENABLED=') { $enabledIndexes += $i }
  if ($lines[$i] -match '^[ \t]*API_SERVER_KEY=') { $keyIndexes += $i }
  if ($lines[$i] -match '^[ \t]*HERMES_MCP_RELAY_TOKEN=') { $relayIndexes += $i }
}
if ($enabledIndexes.Count -gt 1 -or $keyIndexes.Count -gt 1 -or $relayIndexes.Count -gt 1) { throw 'Hermes has duplicate API or Envoi relay settings; resolve them before connecting.' }
$changed = $false
if ($enabledIndexes.Count -eq 0) { $lines += 'API_SERVER_ENABLED=true'; $changed = $true }
elseif ($lines[$enabledIndexes[0]] -ne 'API_SERVER_ENABLED=true') { $lines[$enabledIndexes[0]] = 'API_SERVER_ENABLED=true'; $changed = $true }

$apiKey = if ($keyIndexes.Count -eq 1) { ($lines[$keyIndexes[0]] -replace '^[ \t]*API_SERVER_KEY=', '').Trim().Trim('"', "'") } else { '' }
if (-not $apiKey) {
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $apiKey = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
  if ($keyIndexes.Count -eq 1) { $lines[$keyIndexes[0]] = "API_SERVER_KEY=$apiKey" }
  else { $lines += "API_SERVER_KEY=$apiKey" }
  $changed = $true
}
$relayKey = if ($relayIndexes.Count -eq 1) { ($lines[$relayIndexes[0]] -replace '^[ \t]*HERMES_MCP_RELAY_TOKEN=', '').Trim().Trim('"', "'") } else { '' }
if (-not $relayKey) {
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $relayKey = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
  if ($relayIndexes.Count -eq 1) { $lines[$relayIndexes[0]] = "HERMES_MCP_RELAY_TOKEN=$relayKey" }
  else { $lines += "HERMES_MCP_RELAY_TOKEN=$relayKey" }
  $changed = $true
}
if ($relayKey.Length -lt 32 -or $relayKey -match '[\r\n]') { throw 'The existing Hermes Envoi relay key is invalid.' }
if ($changed) { [IO.File]::WriteAllLines($hermesEnv, $lines, [Text.UTF8Encoding]::new($false)) }

$gatewayExit = 0
if ($changed) { & $hermesExe gateway restart | Out-Null; $gatewayExit = $LASTEXITCODE }
else {
  $listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 8642 -State Listen -ErrorAction SilentlyContinue
  if (-not $listener) { & $hermesExe gateway start | Out-Null; $gatewayExit = $LASTEXITCODE }
}
if ($gatewayExit -ne 0) { throw 'Hermes Gateway could not start.' }
$listener = $null
for ($attempt = 0; $attempt -lt 30 -and -not $listener; $attempt++) {
  $listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 8642 -State Listen -ErrorAction SilentlyContinue
  if (-not $listener) { Start-Sleep -Milliseconds 500 }
}
if (-not $listener) { throw 'Hermes API Server did not start on 127.0.0.1:8642.' }

Push-Location $repoRoot
try {
  $vite = Join-Path $repoRoot 'node_modules\.bin\vite.cmd'
  if (-not (Test-Path -LiteralPath $vite)) {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'Envoi dependencies could not be installed.' }
  }
  & $vite build --config integrations/hermes/vite.config.ts
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $bundle)) { throw 'Hermes bridge build failed.' }
}
finally { Pop-Location }

# Hermes reads this private key from its own .env. Its config contains only a
# variable reference, never the Envoi access or refresh credential.
$mcpBlock = [string[]]@(
  '  envoi:',
  '    url: "http://127.0.0.1:8789/mcp"',
  '    headers:',
  '      Authorization: "Bearer ${HERMES_MCP_RELAY_TOKEN}"',
  '    tools:',
  '      include: [envoi_agent_info, envoi_start_case, envoi_send_message, envoi_start_group_case, envoi_read_group_case, envoi_send_group_message, envoi_send_proposal, envoi_send_decision, envoi_list_cases, envoi_read_case, envoi_list_messages, envoi_list_assets, envoi_asset_download]',
  '      resources: false',
  '      prompts: false'
)
$config = New-Object 'System.Collections.Generic.List[string]'
if (Test-Path -LiteralPath $hermesConfig) { $config.AddRange([string[]][IO.File]::ReadAllLines($hermesConfig)) }
$mcpSections = @()
for ($i = 0; $i -lt $config.Count; $i++) {
  if ($config[$i] -match '^mcp_servers:') {
    if ($config[$i] -ne 'mcp_servers:') { throw 'Hermes has a nonstandard mcp_servers configuration; preserve it and add Envoi manually.' }
    $mcpSections += $i
  }
}
if ($mcpSections.Count -gt 1) { throw 'Hermes has duplicate mcp_servers sections; preserve them and add Envoi manually.' }
if ($mcpSections.Count -eq 0) {
  if ($config.Count -gt 0 -and $config[$config.Count - 1] -ne '') { $config.Add('') }
  $config.Add('mcp_servers:')
  $config.AddRange($mcpBlock)
  [IO.File]::WriteAllLines($hermesConfig, $config, [Text.UTF8Encoding]::new($false))
} else {
  $start = $mcpSections[0] + 1
  $end = $config.Count
  for ($i = $start; $i -lt $config.Count; $i++) {
    if ($config[$i] -match '^[^\s#]') { $end = $i; break }
  }
  for ($i = $start; $i -lt $end; $i++) {
    if ($config[$i] -match '^  envoi:') {
      $existing = if ($i + $mcpBlock.Length -le $end) { [string[]]$config.GetRange($i, $mcpBlock.Length) } else { [string[]]@() }
      if (($existing -join "`n") -eq ($mcpBlock -join "`n")) { $start = -1; break }
      throw 'Hermes already has a different Envoi MCP entry. Inspect it before replacing it.'
    }
  }
  if ($start -ge 0) {
    $config.InsertRange($start, $mcpBlock)
    [IO.File]::WriteAllLines($hermesConfig, $config, [Text.UTF8Encoding]::new($false))
  }
}

if ($PrepareOnly) {
  Write-Host 'Hermes Gateway and Envoi MCP configuration are ready. Run this script again without -PrepareOnly to connect the agent.'
  return
}

$env:ENVOI_API_URL = $origin.GetLeftPart([UriPartial]::Authority)
$env:ENVOI_STATE_DIR = $StateDir
$env:HERMES_API_URL = 'http://127.0.0.1:8642'
$env:HERMES_API_KEY = $apiKey
$env:HERMES_MCP_RELAY_TOKEN = $relayKey
$env:HERMES_MCP_WRITE_ENABLED = 'true'

try {
  if (-not (Test-Path -LiteralPath $session)) {
    Write-Host 'No saved Envoi session was found for this host.'
    Write-Host 'For an existing agent, use Agent connections > Reconnect runtime. For a new agent, use Enroll an agent.'
    Write-Host 'Do not paste the token into a chat or at the PS> prompt.'
    $enteredToken = ''
    for ($attempt = 0; $attempt -lt 3 -and -not $enteredToken; $attempt++) {
      $secureToken = Read-Host 'Paste the one-use token now (input hidden), then press Enter' -AsSecureString
      $handle = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
      try { $enteredToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($handle) }
      finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($handle) }
      if (-not $enteredToken -and $attempt -lt 2) {
        Write-Host 'Nothing was entered. The script is still waiting for a token; paste at the next hidden-input prompt.'
      }
    }
    if (-not $enteredToken) { throw 'No token was entered after three prompts. Run this script again when you have a fresh token.' }
    $env:ENVOI_ENROLLMENT_TOKEN = $enteredToken
    $enteredToken = ''
  } else { Write-Host "Resuming the saved Envoi agent for $($origin.Host)." }
  Write-Host 'Connecting Hermes to Envoi. Keep this terminal open while testing.'
  Write-Host 'After MCP send tools are ready, start a new Hermes chat. An older chat may retain a stale tool list.'
  & node $bundle
  if ($LASTEXITCODE -ne 0) { throw 'The Hermes bridge stopped. Verify the Gateway and use a fresh token if enrollment did not finish.' }
}
finally {
  Remove-Item Env:\ENVOI_ENROLLMENT_TOKEN, Env:\ENVOI_API_URL, Env:\ENVOI_STATE_DIR, Env:\HERMES_API_URL, Env:\HERMES_API_KEY, Env:\HERMES_MCP_RELAY_TOKEN, Env:\HERMES_MCP_WRITE_ENABLED -ErrorAction SilentlyContinue
}
