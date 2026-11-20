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

function Test-ConnectionCounters($Uri, $Headers, [int]$ProxyPort) {
    $target = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $target.Start()
        $targetPort = $target.LocalEndpoint.Port
        $client.Connect([Net.IPAddress]::Loopback, $ProxyPort)
        $client.ReceiveTimeout = 3000
        $client.SendTimeout = 3000
        $stream = $client.GetStream()
        $endpoint = "127.0.0.1:$targetPort"
        $request = [Text.Encoding]::ASCII.GetBytes("CONNECT $endpoint HTTP/1.1`r`nHost: $endpoint`r`n`r`n")
        $stream.Write($request, 0, $request.Length)
        $pending = $target.AcceptTcpClientAsync()
        if (-not $pending.Wait(3000)) { throw 'The local test traffic did not arrive' }
        $peer = $pending.Result
        try {
            $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::ASCII, $false, 1024, $true)
            try {
                if ($reader.ReadLine() -notmatch '^HTTP/1\.[01] 200 ') { throw 'CONNECT failed' }
                while ($reader.ReadLine()) {}
                $payload = 'relaydesk-telemetry'
                $bytes = [Text.Encoding]::ASCII.GetBytes($payload)
                $peer.GetStream().Write($bytes, 0, $bytes.Length)
                $buffer = [char[]]::new($payload.Length)
                if ($reader.ReadBlock($buffer, 0, $buffer.Length) -ne $buffer.Length -or -join $buffer -ne $payload) {
                    throw 'The test payload did not pass through the core'
                }
                $snapshot = Invoke-RestMethod -Uri $Uri -NoProxy -TimeoutSec 3 -Headers $Headers
                $connection = $snapshot.connections | Where-Object {
                    $_.metadata.destinationIP -eq '127.0.0.1' -and $_.metadata.destinationPort -eq "$targetPort"
                } | Select-Object -First 1
                if (-not $connection -or 'direct' -notin $connection.chains -or
                    $connection.download -lt $bytes.Length -or $snapshot.downloadTotal -lt $bytes.Length) {
                    throw 'Telemetry did not report the live connection, route and byte count'
                }
            } finally {
                $reader.Dispose()
            }
        } finally {
            $peer.Dispose()
        }
    } finally {
        $client.Dispose()
        $target.Stop()
    }
}

function Test-NetworkSession([string]$Mode, [bool]$SimulateCrash) {
    $original = Get-Proxy
    $token = [Guid]::NewGuid().ToString('N')
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $controllerListener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $controllerListener.Start()
    $controllerPort = $controllerListener.LocalEndpoint.Port
    $controllerListener.Stop()
    $listener.Stop()
    $secret = [Guid]::NewGuid().ToString()
    $stop = [Threading.EventWaitHandle]::new($false, 'ManualReset', "Local\RelayDesk.$token.stop")
    $ready = [Threading.EventWaitHandle]::new($false, 'ManualReset', "Local\RelayDesk.$token.ready")
    $configPath = Join-Path $runtime "$token.json"
    $errorLog = Join-Path $env:TEMP "relaydesk-network-$token.log"
    $worker = $null
    $parent = $null
    $outbound = if ($Mode -eq 'local') { 'direct' } else { 'proxy' }
    try {
        @{
            config = @{
                inbounds = @(@{type='mixed'; tag='local'; listen='127.0.0.1'; listen_port=$port})
                outbounds = @(
                    @{type='selector'; tag='proxy'; outbounds=@('node-0','node-1'); default='node-0'; interrupt_exist_connections=$false}
                    @{type='vless'; tag='node-0'; server='127.0.0.1'; server_port=9; uuid='00000000-0000-4000-8000-000000000000'}
                    @{type='vless'; tag='node-1'; server='127.0.0.1'; server_port=10; uuid='00000000-0000-4000-8000-000000000000'}
                    @{type='direct'; tag='direct'}
                )
                route = @{rules=@(); final=$outbound; auto_detect_interface=$true}
            }
            controller = @{port=$controllerPort; secret=$secret}
        } | ConvertTo-Json -Depth 12 -Compress | Set-Content -Encoding utf8NoBOM -LiteralPath $configPath
        $parentId = $PID
        if ($SimulateCrash) {
            $parent = Start-Process -FilePath ping.exe -ArgumentList '127.0.0.1', '-t' -PassThru -WindowStyle Hidden
            $parentId = $parent.Id
        }
        $worker = Start-Process -FilePath $exePath -ArgumentList '--network-worker', $parentId, $token, $port, $Mode -PassThru -WindowStyle Hidden -RedirectStandardError $errorLog
        if (-not $ready.WaitOne(15000)) {
            throw "$Mode worker did not report network readiness; exited=$($worker.HasExited); $(Get-Content -Raw -LiteralPath $errorLog)"
        }
        if ($Mode -eq 'system') {
            $active = Get-Proxy
            if ($active.Enabled -ne 1 -or $active.Server -ne "127.0.0.1:$port") {
                throw 'The system proxy was not set to the local listener'
            }
        }
        if ($Mode -eq 'tun' -and -not (Get-NetIPAddress -IPAddress '172.28.254.1' -ErrorAction SilentlyContinue)) {
            throw 'The TUN virtual interface was not configured'
        }
        $url = "http://127.0.0.1:$controllerPort/connections"
        $response = Invoke-WebRequest -Uri $url -NoProxy -TimeoutSec 3 -SkipHttpErrorCheck
        if ($response.StatusCode -ne 401) { throw 'The local controller must require authentication' }
        $headers = @{Authorization="Bearer $secret"}
        $snapshot = Invoke-RestMethod -Uri $url -NoProxy -TimeoutSec 3 -Headers $headers
        if ($null -eq $snapshot.uploadTotal -or $null -eq $snapshot.downloadTotal -or $null -eq $snapshot.connections) {
            throw 'The authenticated controller did not return traffic counters and connections'
        }
        $selector = "http://127.0.0.1:$controllerPort/proxies/proxy"
        [void](Invoke-RestMethod -Method Put -Uri $selector -NoProxy -TimeoutSec 3 -Headers $headers -ContentType 'application/json' -Body '{"name":"node-1"}')
        if ((Invoke-RestMethod -Uri $selector -NoProxy -TimeoutSec 3 -Headers $headers).now -ne 'node-1') {
            throw 'The installed core did not switch outbound on the running selector'
        }
        if ($Mode -eq 'local') { Test-ConnectionCounters $url $headers $port }
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
                $interface = Get-NetIPAddress -IPAddress '172.28.254.1' -ErrorAction SilentlyContinue
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
        if (Test-Path -LiteralPath $errorLog) { Remove-Item -LiteralPath $errorLog }
        $recovery = Start-Process -FilePath $exePath -ArgumentList '--recover-network' -Wait -PassThru -WindowStyle Hidden
        if ($recovery.ExitCode -ne 0) { throw 'Fallback network recovery failed' }
    }
}

Test-NetworkSession 'local' $false
Test-NetworkSession 'system' $false
Test-NetworkSession 'system' $true
Test-NetworkSession 'tun' $false
