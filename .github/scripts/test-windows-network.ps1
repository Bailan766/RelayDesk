param([Parameter(Mandatory)][string]$App)

$ErrorActionPreference = 'Stop'
$exePath = (Resolve-Path -LiteralPath $App).Path
$settingsPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$runtime = Join-Path $env:LOCALAPPDATA 'RelayDesk\network-state'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null

function Get-Proxy {
    $settings = Get-ItemProperty -LiteralPath $settingsPath
    [PSCustomObject]@{
        Enabled = [int]$settings.ProxyEnable
        Server = [string]$settings.ProxyServer
    }
}

function Test-NetworkSession([string]$Mode, [bool]$SimulateCrash) {
    $original = Get-Proxy
    $token = [Guid]::NewGuid().ToString('N')
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    $stop = [Threading.EventWaitHandle]::new($false, 'ManualReset', "Local\RelayDesk.$token.stop")
    $ready = [Threading.EventWaitHandle]::new($false, 'ManualReset', "Local\RelayDesk.$token.ready")
    $configPath = Join-Path $runtime "$token.json"
    $worker = $null
    $parent = $null
    try {
        @{
            inbounds = @(@{type='mixed'; tag='local'; listen='127.0.0.1'; listen_port=$port})
            outbounds = @(
                @{type='vless'; tag='proxy'; server='127.0.0.1'; server_port=9; uuid='00000000-0000-4000-8000-000000000000'}
                @{type='direct'; tag='direct'}
            )
            route = @{rules=@(); final='proxy'; auto_detect_interface=$true}
        } | ConvertTo-Json -Depth 12 -Compress | Set-Content -Encoding utf8NoBOM -LiteralPath $configPath
        $parentId = $PID
        if ($SimulateCrash) {
            $parent = Start-Process -FilePath ping.exe -ArgumentList '127.0.0.1', '-t' -PassThru -WindowStyle Hidden
            $parentId = $parent.Id
        }
        $worker = Start-Process -FilePath $exePath -ArgumentList '--network-worker', $parentId, $token, $port, $Mode -PassThru -WindowStyle Hidden
        if (-not $ready.WaitOne(15000)) {
            throw "$Mode worker did not report network readiness; exited=$($worker.HasExited)"
        }
        if ($Mode -eq 'system') {
            $active = Get-Proxy
            if ($active.Enabled -ne 1 -or $active.Server -ne "127.0.0.1:$port") {
                throw 'The system proxy was not set to the local listener'
            }
        }
        if ($Mode -eq 'tun' -and -not (Get-NetIPAddress -InterfaceAlias 'RelayDesk' -IPAddress '172.28.254.1' -ErrorAction SilentlyContinue)) {
            throw 'The TUN virtual interface was not configured'
        }
        if ($SimulateCrash) {
            $parent.Kill()
        } else {
            [void]$stop.Set()
        }
        if (-not $worker.WaitForExit(5000) -or $worker.ExitCode -ne 0) {
            throw "$Mode worker did not stop cleanly"
        }
        if ($Mode -eq 'system') {
            $restored = Get-Proxy
            if ($restored.Enabled -ne $original.Enabled -or $restored.Server -ne $original.Server) {
                throw 'The previous system proxy settings were not restored'
            }
        }
        if ($Mode -eq 'tun') {
            for ($attempt = 0; $attempt -lt 30; $attempt++) {
                $interface = Get-NetIPAddress -InterfaceAlias 'RelayDesk' -IPAddress '172.28.254.1' -ErrorAction SilentlyContinue
                if (-not $interface) { break }
                Start-Sleep -Milliseconds 100
            }
            if ($interface) { throw 'TUN IP address remained after stopping' }
        }
        Write-Host "Verified $Mode startup and teardown (parent crash: $SimulateCrash)"
    } finally {
        [void]$stop.Set()
        if ($worker -and -not $worker.WaitForExit(5000)) { $worker.Kill(); [void]$worker.WaitForExit(3000) }
        if ($parent -and -not $parent.HasExited) { $parent.Kill() }
        $stop.Dispose()
        $ready.Dispose()
        if (Test-Path -LiteralPath $configPath) { Remove-Item -LiteralPath $configPath }
        $recovery = Start-Process -FilePath $exePath -ArgumentList '--recover-network' -Wait -PassThru -WindowStyle Hidden
        if ($recovery.ExitCode -ne 0) { throw 'Fallback network recovery failed' }
    }
}

Test-NetworkSession 'system' $false
Test-NetworkSession 'system' $true
Test-NetworkSession 'tun' $false
