/**
 * System metrics, without any npm dependency.
 *
 *  CPU / RAM : `os` module (deltas of cumulative counters)
 *  GPU       : `nvidia-smi` (~0.16 s per run, every GPU_MS)
 *  Network   : ONE long-running process (PowerShell on Windows, /proc/net/dev
 *              on Linux): spawning PowerShell costs 0.82 s, far too slow every second.
 */

const os = require('os');
const fs = require('fs');
const { spawn, execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';
const GPU_MS = 2000;
const TICK_MS = 1000;

/* ---------------- CPU ---------------- */

function cpuSnapshot() {
  return os.cpus().map((c) => {
    const t = c.times;
    return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
  });
}

let prevCpu = cpuSnapshot();
// Read once: os.cpus() builds one object per core, too costly every second for
// a constant label.
const CPU_MODEL = (os.cpus()[0] || {}).model || 'CPU';

function cpuUsage() {
  const now = cpuSnapshot();
  const per = now.map((c, i) => {
    const p = prevCpu[i];
    if (!p) return 0;
    const dTotal = c.total - p.total;
    const dIdle = c.idle - p.idle;
    if (dTotal <= 0) return 0;
    return Math.min(100, Math.max(0, ((dTotal - dIdle) / dTotal) * 100));
  });
  prevCpu = now;
  const avg = per.length ? per.reduce((a, b) => a + b, 0) / per.length : 0;
  return { per, avg };
}

/* ---------------- RAM ---------------- */

function ramUsage() {
  const total = os.totalmem();
  const free = os.freemem();
  return { total, free, used: total - free, pct: ((total - free) / total) * 100 };
}

/* ---------------- GPU ---------------- */

const GPU_QUERY = 'utilization.gpu,memory.used,memory.total,fan.speed,temperature.gpu';
const GPU_RETRY_MS = 30000;
let gpuState = null;
let gpuName = null;
let gpuRetryAt = 0;

function pollGpu() {
  if (Date.now() < gpuRetryAt) return;
  execFile(
    'nvidia-smi',
    [`--query-gpu=name,${GPU_QUERY}`, '--format=csv,noheader,nounits'],
    { timeout: 4000, windowsHide: true },
    (err, stdout) => {
      if (err) {
        gpuState = null;
        // No nvidia-smi: no NVIDIA GPU, stop trying. Any other failure (driver being
        // updated, timeout under load): retry later.
        gpuRetryAt = err.code === 'ENOENT' ? Infinity : Date.now() + GPU_RETRY_MS;
        return;
      }
      const parts = stdout.trim().split('\n')[0].split(',').map((s) => s.trim());
      if (parts.length < 6) return;
      gpuName = parts[0];
      const num = (s) => {
        const n = parseFloat(s);
        return Number.isFinite(n) ? n : null;
      };
      gpuState = {
        name: gpuName,
        util: num(parts[1]),
        memUsed: num(parts[2]),   // MiB
        memTotal: num(parts[3]),  // MiB
        fan: num(parts[4]),       // % ("[N/A]" -> null when the fan is not controlled)
        temp: num(parts[5]),      // °C
      };
    }
  );
}

/* ---------------- network ---------------- */

// The loop exits by itself when Klakboard is gone (crash, killed process), so
// it never keeps running in the background.
const PS_NET_LOOP = `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  if (-not (Get-Process -Id ${process.pid})) { exit }
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
  Start-Sleep -Milliseconds ${TICK_MS}
}
`;

function readProcNetDev() {
  // Linux/WSL fallback: sum of the physical interfaces (no lo, no virtual ones).
  try {
    const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
    let rx = 0;
    let tx = 0;
    for (const line of lines) {
      const [rawName, rest] = line.split(':');
      if (!rest) continue;
      const name = rawName.trim();
      if (/^(lo|docker|veth|br-|virbr)/.test(name)) continue;
      const f = rest.trim().split(/\s+/);
      rx += Number(f[0]) || 0;
      tx += Number(f[8]) || 0;
    }
    return { rx, tx };
  } catch {
    return null;
  }
}

let netProc = null;
let netTimer = null;
let netStopped = false;
let netRestartMs = 2000;
let prevNet = null;      // { rx, tx, at }
let netRate = { down: 0, up: 0 };   // bytes/s; null when the counters stop coming
let netDelta = { rx: 0, tx: 0 };    // bytes since the previous tick

function onNetCounters(rx, tx) {
  const at = Date.now();
  if (prevNet) {
    const dt = (at - prevNet.at) / 1000;
    // A counter going backwards means the adapter was reset: start again from zero.
    const dRx = rx >= prevNet.rx ? rx - prevNet.rx : 0;
    const dTx = tx >= prevNet.tx ? tx - prevNet.tx : 0;
    if (dt > 0) netRate = { down: dRx / dt, up: dTx / dt };
    netDelta = { rx: dRx, tx: dTx };
  }
  prevNet = { rx, tx, at };
}

/** Starts the PowerShell loop, restarted with a growing delay if it stops. */
function spawnNetLoop() {
  const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_NET_LOOP], {
    windowsHide: true,
  });
  netProc = proc;
  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const [rx, tx] = line.trim().split(/\s+/).map(Number);
      if (Number.isFinite(rx) && Number.isFinite(tx)) {
        onNetCounters(rx, tx);
        netRestartMs = 2000;
      }
    }
  });
  // 'error' (spawn failed) and 'exit' may both fire: restart only once.
  let restarted = false;
  const restart = () => {
    if (restarted) return;
    restarted = true;
    if (netProc === proc) netProc = null;
    if (netStopped) return;
    setTimeout(spawnNetLoop, netRestartMs);
    netRestartMs = Math.min(netRestartMs * 2, 60000);
  };
  proc.on('error', restart);
  proc.on('exit', restart);
}

function startNet() {
  netStopped = false;
  if (IS_WIN) {
    spawnNetLoop();
  } else {
    netTimer = setInterval(() => {
      const c = readProcNetDev();
      if (c) onNetCounters(c.rx, c.tx);
    }, TICK_MS);
  }
}

/* ---------------- loop ---------------- */

let tickTimer;
let gpuTimer;

function start(onSample) {
  startNet();
  pollGpu();
  gpuTimer = setInterval(pollGpu, GPU_MS);

  tickTimer = setInterval(() => {
    // Silent counters (network loop stopped): do not show a frozen rate.
    if (prevNet && Date.now() - prevNet.at > 3 * TICK_MS) netRate = null;
    const sample = {
      cpu: cpuUsage(),
      ram: ramUsage(),
      gpu: gpuState,
      net: { rate: netRate, delta: netDelta },
      cpuModel: CPU_MODEL,
    };
    // Consume the delta: it must be counted only once.
    netDelta = { rx: 0, tx: 0 };
    onSample(sample);
  }, TICK_MS);
}

function stop() {
  netStopped = true;
  clearInterval(tickTimer);
  clearInterval(gpuTimer);
  clearInterval(netTimer);
  if (netProc) netProc.kill();
}

module.exports = { start, stop };
