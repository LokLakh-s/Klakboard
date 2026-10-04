/**
 * Remplacement d'app.asar, execute APRES la fermeture de Klakboard.
 *
 * Lance par main.js via Klakboard.exe en mode Node (ELECTRON_RUN_AS_NODE), depuis
 * une copie dans le dossier temporaire. Klakboard.exe est un programme graphique :
 * contrairement a un script cmd.exe, il n'ouvre aucune fenetre de console.
 *
 * Arguments : <pid a attendre> <app.asar.new> <app.asar> <exe a relancer> <journal>
 */

// Les chemins manipules finissent en .asar : on desactive le support des archives
// pour qu'ils soient traites comme de simples fichiers.
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

  // Les sous-process de Chromium peuvent garder app.asar ouvert quelques instants.
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
