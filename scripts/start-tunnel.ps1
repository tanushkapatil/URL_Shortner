# Starts (or restarts) a Cloudflare quick tunnel to the Kubernetes gateway and prints the public URL.
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\start-tunnel.ps1
$cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
$log = Join-Path $env:TEMP 'snip-tunnel.log'

# A quick tunnel's address dies when the laptop sleeps, so always start a fresh one.
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item $log -ErrorAction SilentlyContinue

$local = try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 http://localhost:30080/healthz).StatusCode } catch { 0 }
if ($local -ne 200) {
    Write-Warning 'The app is not answering on http://localhost:30080. Is Docker Desktop running (and not paused)?'
}

$p = Start-Process -FilePath $cloudflared -ArgumentList 'tunnel', '--no-autoupdate', '--url', 'http://localhost:30080' `
    -WindowStyle Hidden -RedirectStandardError $log -PassThru

$url = $null
for ($i = 0; $i -lt 30 -and -not $url; $i++) {
    Start-Sleep -Seconds 2
    $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($m) { $url = $m.Matches[0].Value }
}
if (-not $url) { Write-Error "Tunnel did not start. See $log"; exit 1 }

# Wait until Cloudflare has registered the connection before handing out the link.
for ($i = 0; $i -lt 20; $i++) {
    if (Select-String -Path $log -Pattern 'Registered tunnel connection' -Quiet) { break }
    Start-Sleep -Seconds 1
}

Set-Clipboard -Value $url
Write-Host ''
Write-Host "Public URL: $url   (copied to clipboard)" -ForegroundColor Green
Write-Host "cloudflared PID $($p.Id) - log: $log"
Write-Host 'The link works while this laptop is awake and Docker Desktop is running.'
