/**
 * Windows sources. One long-running PowerShell process per source: spawning
 * PowerShell costs ~0.8 s, far too slow every second.
 *
 *   network : Get-NetAdapterStatistics, summed over the physical adapters
 *   GPU     : performance counters through CIM (any vendor), used when
 *             nvidia-smi is missing. CIM class names are not localised, unlike
 *             Get-Counter paths, so this works on every Windows language.
 */

const { spawnLines } = require('./spawn-lines');

const ps = (script) => ['-NoProfile', '-NonInteractive', '-Command', script];

// Each loop exits by itself when Klakboard is gone (crash, killed process), so
// it never keeps running in the background.
const netScript = (pid, tickMs) => `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  if (-not (Get-Process -Id ${pid})) { exit }
  $s = Get-NetAdapterStatistics | Where-Object {
    $_.Name -notlike '*vEthernet*' -and
    $_.Name -notlike '*Loopback*'  -and
    $_.Name -notlike '*isatap*'
  }
  $rx = ($s | Measure-Object -Property ReceivedBytes -Sum).Sum
  $tx = ($s | Measure-Object -Property SentBytes -Sum).Sum
  try {
    [Console]::Out.WriteLine("$rx $tx")
    [Console]::Out.Flush()
  } catch { exit }
  Start-Sleep -Milliseconds ${tickMs}
}
`;

// 3D engine load summed over processes (what Task Manager shows as "3D"), and
// dedicated memory in use. No line while the counters do not exist.
const gpuScript = (pid, intervalMs) => `
$ErrorActionPreference = 'SilentlyContinue'
$name = (Get-CimInstance Win32_VideoController | Where-Object { $_.Name -notlike '*Basic*' } | Select-Object -First 1).Name
while ($true) {
  if (-not (Get-Process -Id ${pid})) { exit }
  $e = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | Where-Object { $_.Name -like '*engtype_3D' }
  if ($e) {
    $u = ($e | Measure-Object -Property UtilizationPercentage -Sum).Sum
    $m = (Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory | Measure-Object -Property DedicatedUsage -Sum).Sum
    try {
      [Console]::Out.WriteLine((@{ name = $name; util = $u; mem = $m } | ConvertTo-Json -Compress))
      [Console]::Out.Flush()
    } catch { exit }
  }
  Start-Sleep -Milliseconds ${intervalMs}
}
`;

/** Line of the network loop ("<rx> <tx>") -> counters, or null. */
function parseNetLine(line) {
  const [rx, tx] = line.trim().split(/\s+/).map(Number);
  return Number.isFinite(rx) && Number.isFinite(tx) ? { rx, tx } : null;
}

/** JSON line of the GPU loop -> GPU sample (memory in MiB, total unknown), or null. */
function parseGpuLine(line) {
  let d;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  // Number(null) is 0: a missing value must not read as an idle GPU.
  const util = d.util == null ? NaN : Number(d.util);
  const mem = d.mem == null ? NaN : Number(d.mem);
  if (!Number.isFinite(util)) return null;
  return {
    name: d.name || 'GPU',
    util: Math.min(100, Math.round(util)),
    memUsed: Number.isFinite(mem) && mem > 0 ? mem / 2 ** 20 : null,
    memTotal: null,
    fan: null,
    temp: null,
  };
}

const net = {
  start(onCounters, tickMs) {
    return spawnLines('powershell.exe', ps(netScript(process.pid, tickMs)), {
      onLine(line) {
        const c = parseNetLine(line);
        if (c) onCounters(c.rx, c.tx);
        return !!c;
      },
    });
  },
};

const gpu = {
  start(onGpu, intervalMs) {
    return spawnLines('powershell.exe', ps(gpuScript(process.pid, intervalMs)), {
      onLine(line) {
        const g = parseGpuLine(line);
        if (g) onGpu(g);
        return !!g;
      },
      maxDelay: 120000,
    });
  },
};

module.exports = { net, gpu, parseNetLine, parseGpuLine };
