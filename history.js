/**
 * System metrics history, kept in the main process so that a chart opens with
 * its past already drawn, even after the page reloads.
 *
 * Two tiers: every second for 10 minutes, and 10-second averages for an hour.
 * Values are Float32Array rings; a missing value (no GPU, silent network
 * counters, lost ping) is NaN. 32 cores x 960 points is about 120 kB.
 */

const FINE_LEN = 600;      // 10 min at 1 s
const COARSE_STEP = 10;    // fine samples per coarse point
const COARSE_LEN = 360;    // 1 h at 10 s

// Series kept besides the per-core loads.
const SERIES = ['cpu', 'ram', 'gpu', 'gpuMem', 'gpuTemp', 'down', 'up', 'ping'];

class Ring {
  constructor(size, Type = Float32Array) {
    this.buf = new Type(size);
    this.size = size;
    this.len = 0;
    this.pos = 0;   // next write
  }

  push(v) {
    this.buf[this.pos] = v;
    this.pos = (this.pos + 1) % this.size;
    if (this.len < this.size) this.len++;
  }

  /** The last `n` values (all by default), oldest first. */
  last(n = this.len) {
    const count = Math.min(n, this.len);
    const out = new this.buf.constructor(count);
    const start = (this.pos - count + this.size) % this.size;
    for (let i = 0; i < count; i++) out[i] = this.buf[(start + i) % this.size];
    return out;
  }
}

const num = (v) => (v == null || !Number.isFinite(v) ? NaN : v);

/** Mean of the finite values, NaN when there is none. */
function mean(values) {
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (Number.isFinite(v)) { sum += v; n++; }
  }
  return n ? sum / n : NaN;
}

function createTier(size, cores) {
  const tier = { t: new Ring(size, Float64Array), cores: [], series: {} };
  for (let i = 0; i < cores; i++) tier.cores.push(new Ring(size));
  for (const k of SERIES) tier.series[k] = new Ring(size);
  return tier;
}

function createHistory() {
  let fine = null;
  let coarse = null;
  let pending = [];   // fine points not yet averaged into the coarse tier

  /** Adds one system sample (shape of system.js samples). */
  function push(sample, at = Date.now()) {
    const cores = sample.cpu.per.length;
    if (!fine || fine.cores.length !== cores) {
      fine = createTier(FINE_LEN, cores);
      coarse = createTier(COARSE_LEN, cores);
      pending = [];
    }
    const point = {
      t: at,
      cores: sample.cpu.per.map(num),
      cpu: num(sample.cpu.avg),
      ram: num(sample.ram.pct),
      gpu: num(sample.gpu?.util),
      gpuMem: num(sample.gpu?.memUsed),
      gpuTemp: num(sample.gpu?.temp),
      down: num(sample.net.rate?.down),
      up: num(sample.net.rate?.up),
      ping: num(sample.ping),
    };
    write(fine, point);
    pending.push(point);
    if (pending.length === COARSE_STEP) {
      write(coarse, {
        t: pending[pending.length - 1].t,
        cores: point.cores.map((_, i) => mean(pending.map((p) => p.cores[i]))),
        ...Object.fromEntries(SERIES.map((k) => [k, mean(pending.map((p) => p[k]))])),
      });
      pending = [];
    }
  }

  function write(tier, p) {
    tier.t.push(p.t);
    p.cores.forEach((v, i) => tier.cores[i].push(v));
    for (const k of SERIES) tier.series[k].push(p[k]);
  }

  /**
   * History over `range` ('1m', '5m', '10m' at 1 s; '1h' at 10 s), oldest first:
   * { t: Float64Array (ms), cores: Float32Array[], cpu, ram, gpu, gpuMem, gpuTemp,
   *   down, up, ping: Float32Array }.
   */
  function get(range) {
    const [tier, n] = {
      '1m': [fine, 60], '5m': [fine, 300], '10m': [fine, FINE_LEN], '1h': [coarse, COARSE_LEN],
    }[range] || [fine, FINE_LEN];
    if (!tier) return { t: new Float64Array(0), cores: [], ...Object.fromEntries(SERIES.map((k) => [k, new Float32Array(0)])) };
    return {
      t: tier.t.last(n),
      cores: tier.cores.map((r) => r.last(n)),
      ...Object.fromEntries(SERIES.map((k) => [k, tier.series[k].last(n)])),
    };
  }

  return { push, get };
}

module.exports = { createHistory, Ring, mean, FINE_LEN, COARSE_LEN, COARSE_STEP };
