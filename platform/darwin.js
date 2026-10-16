/**
 * macOS sources, from built-in commands (cheap to spawn on macOS).
 *
 *   network : netstat -ibn, link-level rows of the physical interfaces
 *   RAM     : vm_stat. os.freemem() only counts free pages, which would show
 *             the memory as always full.
 *   GPU     : ioreg IOAccelerator statistics (Apple silicon and AMD); memory is
 *             shared with the system, so there is no VRAM total.
 */

const os = require('os');
const { execFile } = require('child_process');

const run = (cmd, args, cb) => execFile(cmd, args, { timeout: 4000 }, (err, stdout) => cb(err ? null : stdout));

// Loopback, VPN tunnels, AirDrop and other virtual interfaces.
const VIRTUAL_IF = /^(lo|utun|awdl|llw|bridge|gif|stf|anpi|ap\d|vmenet|ipsec|ppp)/;

/** netstat -ibn output -> { rx, tx } summed over the physical interfaces, or null. */
function parseNetstat(text) {
  let rx = 0;
  let tx = 0;
  let seen = false;
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/);
    // One link-level row per interface ("<Link#n>"); the Address column may be
    // empty, so byte counts are read from the end: ... Ibytes Opkts Oerrs Obytes Coll.
    if (f.length < 8 || !f[2]?.startsWith('<Link#') || VIRTUAL_IF.test(f[0])) continue;
    const ib = Number(f[f.length - 5]);
    const ob = Number(f[f.length - 2]);
    if (!Number.isFinite(ib) || !Number.isFinite(ob)) continue;
    rx += ib;
    tx += ob;
    seen = true;
  }
  return seen ? { rx, tx } : null;
}

/**
 * vm_stat output -> available bytes (free, inactive and speculative pages,
 * which the system reclaims on demand), or null.
 */
function parseVmStat(text) {
  const page = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  if (!page) return null;
  const pages = (label) => Number(new RegExp(`^Pages ${label}:\\s+(\\d+)`, 'm').exec(text)?.[1]) || 0;
  return (pages('free') + pages('inactive') + pages('speculative')) * page;
}

/** ioreg -c IOAccelerator output -> { util, memUsed (MiB) }, or null. */
function parseIoreg(text) {
  const util = /"Device Utilization %"\s*=\s*(\d+)/.exec(text);
  if (!util) return null;
  const mem = /"In use system memory"\s*=\s*(\d+)/.exec(text);
  return { util: Number(util[1]), memUsed: mem ? Number(mem[1]) / 2 ** 20 : null };
}

const net = {
  start(onCounters, tickMs) {
    const read = () => run('netstat', ['-ibn'], (out) => {
      const c = out && parseNetstat(out);
      if (c) onCounters(c.rx, c.tx);
    });
    read();
    const timer = setInterval(read, tickMs);
    return { stop: () => clearInterval(timer) };
  },
};

let available = null;
const ram = {
  start(intervalMs) {
    const read = () => run('vm_stat', [], (out) => {
      const bytes = out && parseVmStat(out);
      if (bytes != null) available = bytes;
    });
    read();
    const timer = setInterval(read, intervalMs);
    return { stop: () => clearInterval(timer) };
  },
  /** Available bytes from the last vm_stat, os.freemem() until then. */
  free: () => available ?? os.freemem(),
};

const gpu = {
  start(onGpu, intervalMs) {
    let name = 'GPU';
    run('system_profiler', ['SPDisplaysDataType', '-json'], (out) => {
      try {
        name = JSON.parse(out).SPDisplaysDataType[0].sppci_model || name;
      } catch {
        /* keep the generic name */
      }
    });
    const read = () => run('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], (out) => {
      const g = out && parseIoreg(out);
      if (g) onGpu({ name, util: g.util, memUsed: g.memUsed, memTotal: null, fan: null, temp: null });
    });
    read();
    const timer = setInterval(read, intervalMs);
    return { stop: () => clearInterval(timer) };
  },
};

module.exports = { net, ram, gpu, parseNetstat, parseVmStat, parseIoreg };
