$processes = Get-CimInstance Win32_Process -Filter "Name = 'language_server_windows_x64.exe'"
foreach ($p in $processes) {
    $procId = $p.ProcessId
    $cmd = $p.CommandLine
    $token = ""
    if ($cmd -match '--csrf_token\s+([a-f0-9\-]+)') {
        $token = $matches[1]
    }
    $conns = Get-NetTCPConnection -OwningProcess $procId -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
        $port = $c.LocalPort
        Write-Output ("INFO|" + $procId + "|" + $token + "|" + $port)
    }
}
