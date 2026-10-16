/**
 * Linux sources, read from files (no process to spawn).
 *
 *   network : /proc/net/dev, summed over the physical interfaces
 *   GPU     : amdgpu sysfs (load, VRAM, temperature), used when nvidia-smi is
 *             missing. Intel GPUs expose no load there: no GPU data for them.
 */

const fs = require('fs');
const path = require('path');

// Loopback, containers, bridges, VMs, and VPN tunnels: their traffic is also
// counted on the physical interface that carries it.
const VIRTUAL_IF = /^(lo|docker|veth|br-|virbr|vnet|tun|tap|wg|tailscale|zt|cali|flannel|cni|kube)/;

/** /proc/net/dev content -> { rx, tx } summed over the physical interfaces. */
function parseProcNetDev(text) {
  let rx = 0;
  let tx = 0;
  for (const line of text.split('\n').slice(2)) {
    const [rawName, rest] = line.split(':');
    if (!rest) continue;
    if (VIRTUAL_IF.test(rawName.trim())) continue;
    const f = rest.trim().split(/\s+/);
    rx += Number(f[0]) || 0;
    tx += Number(f[8]) || 0;
  }
  return { rx, tx };
}

const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
};
const readNum = (file) => {
  const text = readText(file);
  const n = Number(text);
  return text && Number.isFinite(n) ? n : null;
};

/**
 * First AMD GPU under `drmRoot` (/sys/class/drm) that reports its load, as a
 * GPU sample (memory in MiB), or null.
 */
function readAmdGpu(drmRoot = '/sys/class/drm') {
  let cards;
  try {
    cards = fs.readdirSync(drmRoot).filter((c) => /^card\d+$/.test(c)).sort();
  } catch {
    return null;
  }
  for (const card of cards) {
    const dev = path.join(drmRoot, card, 'device');
    if (readText(path.join(dev, 'vendor')) !== '0x1002') continue;
    const util = readNum(path.join(dev, 'gpu_busy_percent'));
    if (util == null) continue;
    const used = readNum(path.join(dev, 'mem_info_vram_used'));
    const total = readNum(path.join(dev, 'mem_info_vram_total'));
    let temp = null;
    try {
      const hwmon = fs.readdirSync(path.join(dev, 'hwmon')).sort()[0];
      const milli = hwmon && readNum(path.join(dev, 'hwmon', hwmon, 'temp1_input'));
      if (milli != null) temp = Math.round(milli / 1000);
    } catch {
      /* no hwmon: no temperature */
    }
    return {
      name: readText(path.join(dev, 'product_name')) || 'AMD GPU',
      util,
      memUsed: used != null ? used / 2 ** 20 : null,
      memTotal: total != null ? total / 2 ** 20 : null,
      fan: null,
      temp,
    };
  }
  return null;
}

const net = {
  start(onCounters, tickMs) {
    const read = () => {
      const text = readText('/proc/net/dev');
      if (text) {
        const c = parseProcNetDev(text);
        onCounters(c.rx, c.tx);
      }
    };
    read();
    const timer = setInterval(read, tickMs);
    return { stop: () => clearInterval(timer) };
  },
};

const gpu = {
  start(onGpu, intervalMs) {
    const read = () => {
      const g = readAmdGpu();
      if (g) onGpu(g);
    };
    read();
    const timer = setInterval(read, intervalMs);
    return { stop: () => clearInterval(timer) };
  },
};

module.exports = { net, gpu, parseProcNetDev, readAmdGpu };
