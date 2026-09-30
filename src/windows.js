'use strict';
// Pilotage des fenêtres d'applications, côté système.
//
// Chaque application Android tourne dans un processus scrcpy dont la fenêtre
// appartient au gestionnaire de fenêtres — Aura n'en est pas propriétaire et ne
// peut donc pas la lever par ses propres moyens. On passe par les outils X11
// présents sur la machine, avec une dégradation ordonnée : ce qui compte, c'est
// que cliquer sur une fenêtre réduite la ramène. Si seule la levée est possible,
// c'est déjà l'essentiel.
//
// Le lien entre une fenêtre et une session est le **PID** du processus scrcpy,
// jamais son titre : deux applications peuvent porter le même nom, et un titre
// se laisse changer.

const { execFile } = require('child_process');

const session = require('./session');

function run(bin, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout }, (err, stdout) =>
      resolve({ ok: !err, stdout: stdout || '' })
    );
  });
}

let available = null;

/// Oublie ce qui a été trouvé — après un changement de réglage, par exemple.
function reset() {
  available = null;
}

/// Outils présents sur la machine, testés une seule fois.
///
/// Le test d'existence ne suffit pas : `wmctrl` s'installe très bien dans une
/// session Wayland, où il ne verra jamais une fenêtre native. On tranche donc
/// d'abord sur le protocole, puis seulement sur les binaires.
async function tools(options = {}) {
  if (available) return available;

  const verdict = session.windowControl(options);
  if (!verdict.possible) {
    available = { wmctrl: false, xdotool: false, xprop: false, xlib: false, raison: verdict.raison };
    return available;
  }
  const [wmctrl, xdotool, xprop, python] = await Promise.all([
    run('wmctrl', ['-m']),
    run('xdotool', ['--version']),
    run('xprop', ['-version']),
    run('python3', ['-c', 'import Xlib']),
  ]);
  available = {
    wmctrl: wmctrl.ok,
    xdotool: xdotool.ok,
    xprop: xprop.ok,
    xlib: python.ok,
    // « x11 » ou « xwayland » : la seconde dit que les fenêtres de scrcpy
    // transitent par la couche de compatibilité, et que c'est ce qui les rend
    // pilotables. Utile au diagnostic, où l'on cherche pourquoi ça marche ici
    // et pas là.
    via: verdict.via,
  };
  return available;
}

/// Identifiant X11 de la fenêtre appartenant à ce processus.
async function windowOf(pid) {
  const { wmctrl } = await tools();
  if (!wmctrl || !pid) return null;

  const listing = await run('wmctrl', ['-lp']);
  if (!listing.ok) return null;

  for (const line of listing.stdout.split('\n')) {
    // `0x08e00039  0 615713 machine  Calculatrice`
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    if (Number(parts[2]) === Number(pid)) return parts[0];
  }
  return null;
}

async function activeWindow() {
  const { xprop } = await tools();
  if (!xprop) return null;
  const out = await run('xprop', ['-root', '_NET_ACTIVE_WINDOW']);
  const match = /window id # (0x[0-9a-f]+)/i.exec(out.stdout);
  // wmctrl écrit les identifiants sur huit chiffres, xprop les tronque.
  return match ? normalize(match[1]) : null;
}

function normalize(id) {
  return `0x${parseInt(id, 16).toString(16).padStart(8, '0')}`;
}

async function raise(id) {
  const { wmctrl } = await tools();
  if (!wmctrl) return false;
  const out = await run('wmctrl', ['-i', '-a', id]);
  return out.ok;
}

/// Réduit une fenêtre.
///
/// `wmctrl` ne sait pas le faire : réduire une fenêtre passe par un message
/// `WM_CHANGE_STATE`, que la spécification réserve au client. `xdotool` le
/// fait ; à défaut, python-xlib, très souvent présent sur les bureaux Linux.
async function minimize(id) {
  const { xdotool, xlib } = await tools();

  if (xdotool) {
    const out = await run('xdotool', ['windowminimize', id]);
    if (out.ok) return true;
  }
  if (xlib) {
    const script =
      'import sys\n' +
      'from Xlib import display, X, protocol\n' +
      'd = display.Display(); root = d.screen().root\n' +
      "w = d.create_resource_object('window', int(sys.argv[1], 16))\n" +
      "ev = protocol.event.ClientMessage(window=w, client_type=d.intern_atom('WM_CHANGE_STATE'), data=(32, [3, 0, 0, 0, 0]))\n" +
      'root.send_event(ev, event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)\n' +
      'd.flush()\n';
    const out = await run('python3', ['-c', script, id]);
    if (out.ok) return true;
  }
  return false;
}

/// Ramène la fenêtre au premier plan, ou la réduit si elle y est déjà.
///
/// Retourne ce qui a été fait, pour que l'interface puisse le dire quand rien
/// n'a pu l'être.
async function toggle(pid, options = {}) {
  const found = await tools(options);
  if (found.raison) return { action: 'none', reason: found.raison };

  const id = await windowOf(pid);
  if (!id) return { action: 'none', reason: 'fenêtre introuvable' };

  const active = await activeWindow();
  if (active && normalize(id) === active) {
    return (await minimize(id))
      ? { action: 'minimized' }
      : { action: 'none', reason: 'la réduction demande xdotool ou python3-xlib' };
  }

  return (await raise(id))
    ? { action: 'raised' }
    : { action: 'none', reason: 'la levée de fenêtre demande wmctrl' };
}

module.exports = { toggle, windowOf, raise, minimize, tools, reset };
