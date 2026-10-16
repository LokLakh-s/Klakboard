/**
 * Long-running process read line by line (PowerShell loops, nvidia-smi -lms):
 * one process instead of one spawn per sample.
 */

const { spawn } = require('child_process');

/**
 * Starts `cmd` and calls `onLine` for each stdout line. The process is
 * restarted with a growing delay when it stops; `onLine` returning true (a line
 * understood) resets that delay. A missing command (ENOENT) is not retried:
 * `onMissing` is called instead.
 *
 * @returns {{ stop(): void }}
 */
function spawnLines(cmd, args, { onLine, onMissing, minDelay = 2000, maxDelay = 60000 } = {}) {
  let proc = null;
  let timer = null;
  let stopped = false;
  let delay = minDelay;

  function launch() {
    const p = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    proc = p;
    p.stdout.setEncoding('utf8');
    let buf = '';
    p.stdout.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (onLine(line.replace(/\r$/, ''))) delay = minDelay;
      }
    });
    // 'error' (spawn failed) and 'exit' may both fire: handle the first only.
    let ended = false;
    const end = (err) => {
      if (ended) return;
      ended = true;
      if (proc === p) proc = null;
      if (stopped) return;
      if (err?.code === 'ENOENT') {
        stopped = true;
        onMissing?.();
        return;
      }
      timer = setTimeout(launch, delay);
      delay = Math.min(delay * 2, maxDelay);
    };
    p.on('error', end);
    p.on('exit', () => end());
  }

  launch();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      if (proc) proc.kill();
    },
  };
}

module.exports = { spawnLines };
