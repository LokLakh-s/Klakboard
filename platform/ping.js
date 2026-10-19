/**
 * Round trip to Quad9's resolver with the system's ping command: ICMP needs no
 * privilege through it, unlike from Node. Like the other sources, one process
 * at a time, read line by line; each run sends a bounded number of pings, so a
 * copy left behind by a crash stops by itself.
 *
 *   Windows        ping -n 600 -w 2000 9.9.9.9    "Reply from …: bytes=32 time=12ms TTL=57" (localised)
 *   macOS, Linux   ping -n -c 600 -i 1 9.9.9.9    "64 bytes from …: icmp_seq=1 ttl=57 time=12.3 ms"
 *
 * A lost answer prints nothing usable: the reading goes stale (see system.js).
 */

const { spawnLines } = require('./spawn-lines');

const HOST = '9.9.9.9';   // anycast and answers ICMP; an address needs no DNS lookup
const COUNT = 600;        // pings per run, about 10 minutes

/**
 * Reply time (ms) in a line of Windows ping, or null. The words are translated
 * ("temps=12 ms", "Zeit=12ms", "время=12мс") but a reply always ends with
 * "TTL=": the time is the number just before it ("<1ms" reads as 1).
 */
function parseWindowsLine(line) {
  const m = /[=<]\s*(\d+)\s*[^\d\s=]*\s+TTL=/i.exec(line);
  return m ? Number(m[1]) : null;
}

/** Reply time (ms) in a line of macOS or Linux ping (run in the C locale), or null. */
function parseUnixLine(line) {
  const m = /\btime[=<]\s*(\d+(?:\.\d+)?)\s*ms\b/.exec(line);
  return m ? Number(m[1]) : null;
}

function start(onReply, platform = process.platform) {
  const win = platform === 'win32';
  const parse = win ? parseWindowsLine : parseUnixLine;
  return spawnLines(
    win ? 'ping.exe' : 'ping',
    win ? ['-n', String(COUNT), '-w', '2000', HOST] : ['-n', '-c', String(COUNT), '-i', '1', HOST],
    {
      onLine(line) {
        const ms = parse(line);
        if (ms != null) onReply(ms);
        return ms != null;
      },
      // English output on macOS and Linux; Windows has no such switch.
      env: win ? undefined : { ...process.env, LC_ALL: 'C' },
      minDelay: 1000,
    },
  );
}

module.exports = { start, parseWindowsLine, parseUnixLine, HOST };
