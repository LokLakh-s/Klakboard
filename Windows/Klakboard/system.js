/**
 * Metriques systeme, sans aucune dependance npm.
 *
 *  CPU / RAM : module `os` (deltas de compteurs cumulatifs)
 *  GPU       : spawn `nvidia-smi` (~0.16 s, tous les GPU_MS)
 *  Reseau    : UN process long (PowerShell sous Windows, /proc/net/dev sous Linux)
 *              -- un spawn PowerShell coute 0.82 s, impensable a chaque seconde.
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
// Releve une seule fois : os.cpus() reconstruit un tableau de 32 objets, le
// rappeler chaque seconde juste pour un libelle constant etait du gaspillage.
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
let gpuState = null;
let gpuName = null;
let gpuAvailable = true;

function pollGpu() {
  if (!gpuAvailable) return;
  execFile(
    'nvidia-smi',
    [`--query-gpu=name,${GPU_QUERY}`, '--format=csv,noheader,nounits'],
    { timeout: 4000, windowsHide: true },
    (err, stdout) => {
      if (err) {
        // Pas de GPU NVIDIA (ou pilote absent) : on arrete d'essayer.
        gpuAvailable = false;
        gpuState = null;
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
        fan: num(parts[4]),       // % ("[N/A]" -> null si ventilo non pilote)
        temp: num(parts[5]),      // °C
      };
    }
  );
}

/* ---------------- Reseau ---------------- */

const PS_NET_LOOP = `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $s = Get-NetAdapterStatistics | Where-Object {
    $_.Name -notlike '*vEthernet*' -and
    $_.Name -notlike '*Loopback*'  -and
    $_.Name -notlike '*isatap*'
  }
  $rx = ($s | Measure-Object -Property ReceivedBytes -Sum).Sum
  $tx = ($s | Measure-Object -Property SentBytes -Sum).Sum
  [Console]::Out.WriteLine("$rx $tx")
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds ${TICK_MS}
}
`;

function readProcNetDev() {
  // Repli Linux/WSL : somme des interfaces physiques (hors lo / virtuelles).
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
let prevNet = null;      // { rx, tx, at }
let netRate = { down: 0, up: 0 };   // octets/s
let netDelta = { rx: 0, tx: 0 };    // octets depuis le tick precedent

function onNetCounters(rx, tx) {
  const at = Date.now();
  if (prevNet) {
    const dt = (at - prevNet.at) / 1000;
    // Un compteur qui recule = adaptateur reinitialise : on repart de zero.
    const dRx = rx >= prevNet.rx ? rx - prevNet.rx : 0;
    const dTx = tx >= prevNet.tx ? tx - prevNet.tx : 0;
    if (dt > 0) netRate = { down: dRx / dt, up: dTx / dt };
    netDelta = { rx: dRx, tx: dTx };
  }
  prevNet = { rx, tx, at };
}

function startNet() {
  if (IS_WIN) {
    netProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_NET_LOOP], {
      windowsHide: true,
    });
    let buf = '';
    netProc.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const [rx, tx] = line.trim().split(/\s+/).map(Number);
        if (Number.isFinite(rx) && Number.isFinite(tx)) onNetCounters(rx, tx);
      }
    });
    netProc.on('error', () => { netProc = null; });
  } else {
    setInterval(() => {
      const c = readProcNetDev();
      if (c) onNetCounters(c.rx, c.tx);
    }, TICK_MS);
  }
}

/* ---------------- boucle ---------------- */

let tickTimer;
let gpuTimer;

function start(onSample) {
  startNet();
  pollGpu();
  gpuTimer = setInterval(pollGpu, GPU_MS);

  tickTimer = setInterval(() => {
    const sample = {
      cpu: cpuUsage(),
      ram: ramUsage(),
      gpu: gpuState,
      net: { rate: netRate, delta: netDelta },
      cpuModel: CPU_MODEL,
    };
    // Consomme le delta : il ne doit etre comptabilise qu'une fois.
    netDelta = { rx: 0, tx: 0 };
    onSample(sample);
  }, TICK_MS);
}

function stop() {
  clearInterval(tickTimer);
  clearInterval(gpuTimer);
  if (netProc) netProc.kill();
}

module.exports = { start, stop };
