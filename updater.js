/**
 * Swaps app.asar, run AFTER Klakboard has closed.
 *
 * Started by main.js through Klakboard.exe in Node mode (ELECTRON_RUN_AS_NODE),
 * from a copy in the temp folder. Klakboard.exe is a GUI program: unlike a
 * cmd.exe script, it opens no console window.
 *
 * Arguments: <pid to wait for> <app.asar.new> <app.asar> <exe to restart> <log>
 */

// The paths end in .asar: disable archive support so they are handled as plain
// files.
process.noAsar = true;

const fs = require('fs');
const { spawn } = require('child_process');

const [pid, staged, target, exe, logFile] = process.argv.slice(2);

const log = (msg) => {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (p) => {
  try {
    process.kill(p, 0);
    return true;
  } catch {
    return false;
  }
};

(async () => {
  log(`attente de la fermeture de Klakboard (pid ${pid})`);
  for (let i = 0; i < 120 && alive(Number(pid)); i++) await sleep(500);

  // Chromium subprocesses may keep app.asar open for a moment.
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      fs.renameSync(staged, target);
      log(`app.asar remplace (essai ${attempt})`);
      break;
    } catch (err) {
      if (attempt === 30) log(`remplacement impossible, ancienne version conservee : ${err.message}`);
      else await sleep(500);
    }
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(exe, [], { detached: true, stdio: 'ignore', env }).unref();
  log('Klakboard relancee');

  try {
    fs.unlinkSync(__filename);
  } catch {}
})();
