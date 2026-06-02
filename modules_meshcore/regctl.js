/*
 * regctl — module meshcore : édition du registre Windows via PowerShell.
 *
 * Reçoit { action:'plugin', plugin:'regctl', pluginaction:X, dispatchId, ... }
 * du serveur, exécute un script PowerShell qui imprime un JSON, parse, et
 * répond { pluginaction:'result', dispatchId, ok, data | error }.
 */

'use strict';

var mesh = null;

function dbg(m) {
    try {
        var fs = require('fs');
        var s = fs.createWriteStream('regctl.txt', { flags: 'a' });
        s.write('\n' + new Date().toLocaleString() + ': ' + m);
        s.end('\n');
    } catch (e) {}
}

function reply(payload) {
    var msg = { action: 'plugin', plugin: 'regctl' };
    Object.keys(payload).forEach(function (k) { msg[k] = payload[k]; });
    try {
        if (mesh && typeof mesh.SendCommand === 'function') mesh.SendCommand(msg);
        else require('MeshAgent').SendCommand(JSON.stringify(msg));
    } catch (e) { dbg('reply error: ' + e); }
}

function consoleaction(args, rights, sessionid, parent) {
    mesh = parent;
    var fnname = args.pluginaction || (args._ && args._[1]);
    try {
        switch (fnname) {
            case 'enumKeys':    return runPs(args, psEnumKeys(args.path));
            case 'enumValues':  return runPs(args, psEnumValues(args.path));
            case 'readValue':   return runPs(args, psReadValue(args.path, args.name));
            case 'writeValue':  return runPs(args, psWriteValue(args.path, args.name, args.type, args.data));
            case 'deleteValue': return runPs(args, psDeleteValue(args.path, args.name));
            case 'deleteKey':   return runPs(args, psDeleteKey(args.path));
            case 'createKey':   return runPs(args, psCreateKey(args.path));
            default:
                reply({ pluginaction: 'result', dispatchId: args.dispatchId, ok: false, error: 'action inconnue: ' + fnname });
        }
    } catch (e) {
        dbg('consoleaction error: ' + e);
        reply({ pluginaction: 'result', dispatchId: args && args.dispatchId, ok: false, error: String(e) });
    }
}

module.exports = { consoleaction: consoleaction };

// --- Builders PowerShell --------------------------------------------------
// Tous les scripts impriment un JSON unique sur stdout via ConvertTo-Json -Compress.
// Sur erreur, on attrape via try/catch et on imprime { __error: '...' }.

function psWrap(body) {
    // Forcer la sortie UTF-8 + neutraliser les warnings progress.
    return [
        '$ErrorActionPreference = "Stop"',
        '$ProgressPreference = "SilentlyContinue"',
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        'try {',
        body,
        '} catch {',
        '  $e = @{ __error = $_.Exception.Message } | ConvertTo-Json -Compress',
        '  Write-Output $e',
        '}'
    ].join('\r\n');
}

function psPath(p) {
    // Convertit HKLM\Software\X en Registry::HKEY_LOCAL_MACHINE\Software\X
    // (PowerShell accepte les deux formats mais Registry:: est sans ambiguïté).
    var map = {
        HKLM: 'HKEY_LOCAL_MACHINE',
        HKCU: 'HKEY_CURRENT_USER',
        HKCR: 'HKEY_CLASSES_ROOT',
        HKU:  'HKEY_USERS',
        HKCC: 'HKEY_CURRENT_CONFIG',
    };
    var s = String(p).replace(/\//g, '\\');
    var m = s.match(/^([A-Z]+)(\\.*)?$/);
    if (m && map[m[1]]) s = map[m[1]] + (m[2] || '');
    return 'Registry::' + s;
}

function escapeForPs(s) {
    // Simple échappement pour insertion dans une string double-quotes PS.
    return String(s).replace(/`/g, '``').replace(/\$/g, '`$').replace(/"/g, '`"');
}

function psEnumKeys(path) {
    return psWrap([
        '$p = "' + escapeForPs(psPath(path)) + '"',
        '$keys = Get-ChildItem -Path $p -ErrorAction Stop | Select-Object -ExpandProperty PSChildName',
        'if ($null -eq $keys) { $keys = @() }',
        '$out = @{ keys = @($keys) } | ConvertTo-Json -Compress',
        'Write-Output $out',
    ].join('\r\n'));
}

function psEnumValues(path) {
    return psWrap([
        '$p = "' + escapeForPs(psPath(path)) + '"',
        '$item = Get-Item -Path $p -ErrorAction Stop',
        '$valNames = $item.GetValueNames()',
        '$list = @()',
        'foreach ($n in $valNames) {',
        '  $kind = $item.GetValueKind($n).ToString()',
        '  $raw  = $item.GetValue($n, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)',
        '  $data = $null',
        '  switch ($kind) {',
        '    "Binary"     { $data = ($raw | ForEach-Object { $_.ToString("X2") }) -join "" }',
        '    "DWord"      { $data = [string]$raw }',
        '    "QWord"      { $data = [string]$raw }',
        '    "MultiString"{ $data = @($raw) }',
        '    default      { $data = [string]$raw }',
        '  }',
        '  $list += @{ name = $n; type = $kind; data = $data }',
        '}',
        '$out = @{ values = $list } | ConvertTo-Json -Compress -Depth 6',
        'Write-Output $out',
    ].join('\r\n'));
}

function psReadValue(path, name) {
    return psWrap([
        '$p = "' + escapeForPs(psPath(path)) + '"',
        '$n = "' + escapeForPs(name) + '"',
        '$item = Get-Item -Path $p -ErrorAction Stop',
        '$kind = $item.GetValueKind($n).ToString()',
        '$raw  = $item.GetValue($n, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)',
        'switch ($kind) {',
        '  "Binary"     { $d = ($raw | ForEach-Object { $_.ToString("X2") }) -join "" }',
        '  "DWord"      { $d = [string]$raw }',
        '  "QWord"      { $d = [string]$raw }',
        '  "MultiString"{ $d = @($raw) }',
        '  default      { $d = [string]$raw }',
        '}',
        '$out = @{ name = $n; type = $kind; data = $d } | ConvertTo-Json -Compress -Depth 6',
        'Write-Output $out',
    ].join('\r\n'));
}

function psWriteValue(path, name, type, data) {
    // type: String, ExpandString, Binary, DWord, QWord, MultiString
    var body;
    var typeNorm = String(type || 'String');
    if (typeNorm === 'Binary') {
        body = [
            '$hex = "' + escapeForPs(String(data).replace(/[^0-9a-fA-F]/g, '')) + '"',
            '$bytes = New-Object byte[] ($hex.Length / 2)',
            'for ($i=0; $i -lt $hex.Length; $i += 2) { $bytes[$i/2] = [Convert]::ToByte($hex.Substring($i,2),16) }',
            'New-ItemProperty -Path $p -Name $n -PropertyType Binary -Value $bytes -Force | Out-Null',
        ].join('\r\n');
    } else if (typeNorm === 'DWord' || typeNorm === 'QWord') {
        body = 'New-ItemProperty -Path $p -Name $n -PropertyType ' + typeNorm + ' -Value ([Int64]"' + escapeForPs(String(data)) + '") -Force | Out-Null';
    } else if (typeNorm === 'MultiString') {
        var lines = Array.isArray(data) ? data : String(data).split(/\r?\n/);
        var quoted = lines.map(function (l) { return '"' + escapeForPs(l) + '"'; }).join(',');
        body = 'New-ItemProperty -Path $p -Name $n -PropertyType MultiString -Value @(' + quoted + ') -Force | Out-Null';
    } else {
        // String, ExpandString
        body = 'New-ItemProperty -Path $p -Name $n -PropertyType ' + typeNorm + ' -Value "' + escapeForPs(String(data)) + '" -Force | Out-Null';
    }
    return psWrap([
        '$p = "' + escapeForPs(psPath(path)) + '"',
        '$n = "' + escapeForPs(name) + '"',
        'if (-not (Test-Path $p)) { New-Item -Path $p -Force | Out-Null }',
        body,
        'Write-Output (@{ ok = $true } | ConvertTo-Json -Compress)',
    ].join('\r\n'));
}

function psDeleteValue(path, name) {
    return psWrap([
        '$p = "' + escapeForPs(psPath(path)) + '"',
        '$n = "' + escapeForPs(name) + '"',
        'Remove-ItemProperty -Path $p -Name $n -Force -ErrorAction Stop',
        'Write-Output (@{ ok = $true } | ConvertTo-Json -Compress)',
    ].join('\r\n'));
}

function psDeleteKey(path) {
    return psWrap([
        '$p = "' + escapeForPs(psPath(path)) + '"',
        'Remove-Item -Path $p -Recurse -Force -ErrorAction Stop',
        'Write-Output (@{ ok = $true } | ConvertTo-Json -Compress)',
    ].join('\r\n'));
}

function psCreateKey(path) {
    return psWrap([
        '$p = "' + escapeForPs(psPath(path)) + '"',
        'New-Item -Path $p -Force | Out-Null',
        'Write-Output (@{ ok = $true } | ConvertTo-Json -Compress)',
    ].join('\r\n'));
}

// --- Exécution PowerShell + parsing JSON ----------------------------------

function runPs(args, script) {
    var dispatchId = args.dispatchId;
    var cp = require('child_process');
    var fs = require('fs');
    var windir = process.env.windir || process.env.WINDIR || 'C:\\Windows';
    var psExe = windir + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    // Écrit le script dans un .ps1 temporaire puis lance via -File.
    // -EncodedCommand serait plus pur mais MeshAgent (Duktape) n'expose pas
    // Buffer.from(..., 'utf16le').toString('base64') de façon fiable.
    var tmpDir = process.env.TEMP || 'C:\\Windows\\Temp';
    var psPath = tmpDir + '\\regctl_' + Date.now() + '_' + Math.floor(Math.random() * 1e9) + '.ps1';
    try { fs.writeFileSync(psPath, script); }
    catch (e) {
        reply({ pluginaction: 'result', dispatchId: dispatchId, ok: false, error: 'write ps1: ' + e });
        return;
    }
    var psArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psPath];
    var child;
    try {
        child = cp.execFile(psExe, psArgs);
    } catch (e) {
        try { fs.unlinkSync(psPath); } catch (e2) {}
        reply({ pluginaction: 'result', dispatchId: dispatchId, ok: false, error: 'spawn: ' + e });
        return;
    }
    var stdout = '', stderr = '';
    try {
        if (child.stdout) child.stdout.on('data', function (c) { stdout += String(c); });
        if (child.stderr) child.stderr.on('data', function (c) { stderr += String(c); });
    } catch (e) {}
    var finished = false;
    child.on('exit', function (code) {
        if (finished) return; finished = true;
        try { fs.unlinkSync(psPath); } catch (e) {}
        finalize(code);
    });
    setTimeout(function () {
        if (finished) return; finished = true;
        try { child.kill(); } catch (e) {}
        try { fs.unlinkSync(psPath); } catch (e) {}
        reply({ pluginaction: 'result', dispatchId: dispatchId, ok: false, error: 'timeout' });
    }, 60 * 1000);

    function finalize(code) {
        var line = stdout.trim();
        if (!line) {
            reply({ pluginaction: 'result', dispatchId: dispatchId, ok: false, error: 'aucune sortie' + (stderr ? ' (' + stderr.slice(0, 200) + ')' : '') + ' exit=' + code });
            return;
        }
        // PowerShell peut imprimer plusieurs lignes — on prend la dernière JSON.
        var lines = line.split(/\r?\n/).filter(function (l) { return l.trim().length > 0; });
        var last = lines[lines.length - 1];
        var parsed = null;
        try { parsed = JSON.parse(last); } catch (e) {
            reply({ pluginaction: 'result', dispatchId: dispatchId, ok: false, error: 'JSON invalide: ' + last.slice(0, 200) });
            return;
        }
        if (parsed && parsed.__error) {
            reply({ pluginaction: 'result', dispatchId: dispatchId, ok: false, error: parsed.__error });
            return;
        }
        reply({ pluginaction: 'result', dispatchId: dispatchId, ok: true, data: parsed });
    }
}
