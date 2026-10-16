/**
 * NVIDIA GPU through nvidia-smi (Windows and Linux): one process printing a
 * line every interval (-lms), first GPU only.
 */

const { spawnLines } = require('./spawn-lines');

const QUERY = 'name,utilization.gpu,memory.used,memory.total,fan.speed,temperature.gpu';

const num = (s) => {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
};

/** One CSV line (noheader, nounits) -> GPU sample, or null when malformed. */
function parseNvidiaLine(line) {
  const parts = line.split(',').map((s) => s.trim());
  if (parts.length < 6 || !parts[0]) return null;
  return {
    name: parts[0],
    util: num(parts[1]),
    memUsed: num(parts[2]),   // MiB
    memTotal: num(parts[3]),  // MiB
    fan: num(parts[4]),       // % ("[N/A]" -> null when the fan is not controlled)
    temp: num(parts[5]),      // °C
  };
}

/**
 * Calls `onGpu(sample)` every `intervalMs`; `onMissing()` when nvidia-smi is not
 * installed (no NVIDIA GPU). Driver errors (nvidia-smi exits) are retried.
 */
function start(onGpu, onMissing, intervalMs) {
  return spawnLines(
    'nvidia-smi',
    ['--id=0', `--query-gpu=${QUERY}`, '--format=csv,noheader,nounits', `-lms`, String(intervalMs)],
    {
      onLine(line) {
        const g = parseNvidiaLine(line);
        if (g) onGpu(g);
        return !!g;
      },
      onMissing,
      minDelay: 30000,
      maxDelay: 120000,
    },
  );
}

module.exports = { start, parseNvidiaLine };
