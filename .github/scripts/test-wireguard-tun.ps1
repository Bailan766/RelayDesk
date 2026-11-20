param([Parameter(Mandatory)][string]$App)

$ErrorActionPreference = 'Stop'
$config = [Console]::ReadLine()
$port = ($config | ConvertFrom-Json).inbounds[0].listen_port
$token = [Guid]::NewGuid().ToString('N')
$interface = "RelayDesk-$($token.Substring(0, 12))"
$controller = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$controller.Start()
$controllerPort = $controller.LocalEndpoint.Port
$controller.Stop()
$runtime = Join-Path $env:LOCALAPPDATA 'RelayDesk/network-state'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$settings = Join-Path $runtime "$token.json"
$log = Join-Path $env:TEMP "relaydesk-wireguard-$token.log"
$ready = [Threading.EventWaitHandle]::new($false, 'ManualReset', "Local\RelayDesk.$token.ready")
$stop = [Threading.EventWaitHandle]::new($false, 'ManualReset', "Local\RelayDesk.$token.stop")
$worker = $null

try {
    if (Get-NetIPAddress -IPAddress '172.28.254.1' -ErrorAction SilentlyContinue) { throw 'An existing RelayDesk TUN is active' }
    @{
        config = $config | ConvertFrom-Json -AsHashtable
        controller = @{port=$controllerPort; secret=[Guid]::NewGuid().ToString()}
    } | ConvertTo-Json -Depth 24 -Compress | Set-Content -Encoding utf8NoBOM -LiteralPath $settings
    $worker = Start-Process -FilePath $App -ArgumentList '--network-worker', $PID, $token, $port, 'tun' -WindowStyle Hidden -PassThru -RedirectStandardError $log
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    while (-not $ready.WaitOne(200) -and -not $worker.HasExited -and $deadline.Elapsed.TotalSeconds -lt 27) {}
    if (-not $ready.WaitOne(0)) {
        throw "WireGuard TUN did not start. $(Get-Content -Raw -LiteralPath $log)"
    }
    if (-not (Get-NetIPAddress -InterfaceAlias $interface -IPAddress '172.28.254.1' -ErrorAction SilentlyContinue)) {
        throw 'WireGuard TUN adapter was not configured'
    }
    [Console]::WriteLine('ready')
    [void][Console]::ReadLine()
} finally {
    [void]$stop.Set()
    try {
        if ($worker) {
            if (-not $worker.WaitForExit(5000)) {
                $worker.Kill()
                [void]$worker.WaitForExit(3000)
                throw 'WireGuard TUN worker did not stop'
            }
            if ($worker.ExitCode -ne 0 -and $ready.WaitOne(0)) { throw 'WireGuard TUN worker failed' }
            for ($attempt = 0; $attempt -lt 30; $attempt++) {
                $address = Get-NetIPAddress -InterfaceAlias $interface -IPAddress '172.28.254.1' -ErrorAction SilentlyContinue
                if (-not $address) { break }
                Start-Sleep -Milliseconds 100
            }
            if ($address) { throw 'WireGuard TUN adapter remained after stopping' }
        }
    } finally {
        $ready.Dispose()
        $stop.Dispose()
        if (Test-Path -LiteralPath $settings) { Remove-Item -LiteralPath $settings }
        if (Test-Path -LiteralPath $log) { Remove-Item -LiteralPath $log }
    }
}
