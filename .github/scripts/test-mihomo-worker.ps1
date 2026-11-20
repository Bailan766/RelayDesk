param([Parameter(Mandatory)][string]$App, [Parameter(Mandatory)][int]$Port)

$ErrorActionPreference = 'Stop'
$profileJson = [Console]::ReadLine()
$token = [Guid]::NewGuid().ToString('N')
$ready = [Threading.EventWaitHandle]::new($false, 'ManualReset', "Local\RelayDesk.$token.ready")
$stop = [Threading.EventWaitHandle]::new($false, 'ManualReset', "Local\RelayDesk.$token.stop")
$runtime = Join-Path $env:LOCALAPPDATA 'RelayDesk/network-state'
$settings = Join-Path $runtime "$token.json"
$homeDirectory = Join-Path $runtime "mihomo-$token"
$log = Join-Path $env:TEMP "relaydesk-mihomo-$token.log"
$worker = $null

try {
    New-Item -ItemType Directory -Force -Path $runtime | Out-Null
    Set-Content -LiteralPath $settings -Value $profileJson -Encoding utf8NoBOM
    $worker = Start-Process -FilePath $App -ArgumentList '--network-worker', $PID, $token, $Port, 'local' -WindowStyle Hidden -PassThru -RedirectStandardError $log
    $elapsed = [Diagnostics.Stopwatch]::StartNew()
    while (-not $ready.WaitOne(200) -and -not $worker.HasExited -and $elapsed.Elapsed.TotalSeconds -lt 40) {}
    if (-not $ready.WaitOne(0)) {
        throw "Mihomo worker did not start. $(Get-Content -LiteralPath $log -Raw -Encoding utf8)"
    }
    [Console]::WriteLine('ready')
    [void][Console]::ReadLine()
} finally {
    [void]$stop.Set()
    try {
        if ($worker) {
            if (-not $worker.WaitForExit(6000)) {
                $worker.Kill()
                [void]$worker.WaitForExit(3000)
                throw 'Mihomo worker did not stop'
            }
            if ($worker.ExitCode -ne 0 -and $ready.WaitOne(0)) { throw 'Mihomo worker reported an error on stop' }
            if (Test-Path -LiteralPath $homeDirectory) { throw 'Mihomo provider cache remained after stop' }
        }
    } finally {
        $ready.Dispose()
        $stop.Dispose()
        if (Test-Path -LiteralPath $settings) { Remove-Item -LiteralPath $settings }
        if (Test-Path -LiteralPath $log) { Remove-Item -LiteralPath $log }
    }
}
