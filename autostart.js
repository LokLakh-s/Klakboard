/**
 * Start at login on Linux: an XDG autostart entry in ~/.config/autostart.
 * Electron's setLoginItemSettings only handles Windows and macOS.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = 'klakboard.desktop';

const autostartDir = (env = process.env) =>
  path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart');

/** Desktop Entry quoting: arguments with reserved characters go in double quotes. */
function quoteArg(arg) {
  if (/^[\w@%+=:,./-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(["`$\\])/g, '\\$1')}"`;
}

function desktopEntry(command) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Klakboard',
    `Exec=${command.map(quoteArg).join(' ')}`,
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

function isEnabled(dir = autostartDir()) {
  try {
    return !/^Hidden=true$/m.test(fs.readFileSync(path.join(dir, FILE), 'utf8'));
  } catch {
    return false;
  }
}

/** @param {string[]} command executable and arguments to start at login */
function setEnabled(on, command, dir = autostartDir()) {
  const file = path.join(dir, FILE);
  if (!on) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, desktopEntry(command));
}

module.exports = { isEnabled, setEnabled, desktopEntry, autostartDir };
