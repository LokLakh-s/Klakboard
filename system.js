/**
 * System metrics, without any npm dependency.
 *
 *  CPU      : `os` module (deltas of cumulative counters)
 *  RAM      : `os` module; vm_stat on macOS (see platform/darwin.js)
 *  GPU      : nvidia-smi when installed, otherwise the platform source
 *             (Windows performance counters, amdgpu sysfs, macOS ioreg)
 *  Network  : platform source (platform/<os>.js)
 *  Ping     : the system's ping command (platform/ping.js)
 */

const os = require('os');
const nvidia = require('./platform/nvidia');
const ping = require('./platform/ping');

const PLATFORM = {
  win32: () => require('./platform/win32'),
  linux: () => require('./platform/linux'),
  darwin: () => require('./platform/darwin'),
}[process.platform]?.() || null;

const GPU_MS = 2000;
const TICK_MS = 1000;
// A GPU sample older than this is not shown (source stopped answering).
const GPU_STALE_MS = 5 * GPU_MS;
// No answer for this long: the ping shows as missing rather than frozen.
const PING_STALE_MS = 3000;

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
  const free = Math.min(total, PLATFORM?.ram ? PLATFORM.ram.free() : os.freemem());
  return { total, free, used: total - free, pct: ((total - free) / total) * 100 };
}

/* ---------------- GPU ---------------- */

let gpuState = null;   // last sample, with its time in `at`

const onGpu = (g) => { gpuState = { ...g, at: Date.now() }; };

function currentGpu() {
  if (!gpuState || Date.now() - gpuState.at > GPU_STALE_MS) return null;
  const { at, ...g } = gpuState;
  return g;
}

/* ---------------- network ---------------- */

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
    netDelta = { rx: netDelta.rx + dRx, tx: netDelta.tx + dTx };
  }
  prevNet = { rx, tx, at };
}

/* ---------------- ping ---------------- */

let pingState = null;   // { ms, at }

const onPing = (ms) => { pingState = { ms, at: Date.now() }; };

const currentPing = () => (pingState && Date.now() - pingState.at <= PING_STALE_MS ? pingState.ms : null);

/* ---------------- loop ---------------- */

let tickTimer;
let sources = [];
let running = false;

function start(onSample) {
  running = true;
  if (PLATFORM) {
    sources.push(PLATFORM.net.start(onNetCounters, TICK_MS));
    if (PLATFORM.ram) sources.push(PLATFORM.ram.start(GPU_MS));
  }
  sources.push(ping.start(onPing));
  // nvidia-smi first; the platform source only when it is not installed.
  sources.push(nvidia.start(onGpu, () => {
    if (running && PLATFORM?.gpu) sources.push(PLATFORM.gpu.start(onGpu, GPU_MS));
  }, GPU_MS));

  tickTimer = setInterval(() => {
    // Silent counters (network source stopped): do not show a frozen rate.
    if (prevNet && Date.now() - prevNet.at > 3 * TICK_MS) netRate = null;
    const sample = {
      cpu: cpuUsage(),
      ram: ramUsage(),
      gpu: currentGpu(),
      net: { rate: netRate, delta: netDelta },
      ping: currentPing(),   // ms, or null
      cpuModel: CPU_MODEL,
    };
    // Consume the delta: it must be counted only once.
    netDelta = { rx: 0, tx: 0 };
    onSample(sample);
  }, TICK_MS);
}

function stop() {
  running = false;
  clearInterval(tickTimer);
  for (const s of sources) s.stop();
  sources = [];
}

module.exports = { start, stop };
