'use strict';
// Tests des parseurs purs de src/device.js, alimentés par des sorties adb /
// scrcpy figées dans test/fixtures/. Chaque bug de parse corrigé doit avoir
// son test ici, pour ne jamais revenir.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const device = require('../src/device.js');

// Normalisation CRLF → LF : un checkout Windows avec autocrlf ne doit pas
// faire échouer les regex ancrées sur les fins de ligne.
const fixture = (name) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8').replace(/\r\n/g, '\n');

// ── parseVersion ────────────────────────────────────────────────────────────

test('parseVersion lit une bannière scrcpy 3.3.4', () => {
  const v = device.parseVersion(fixture('scrcpy-version-3.3.4.txt'));
  assert.deepStrictEqual(v, { major: 3, minor: 3, release: '3.3.4' });
});

test('parseVersion lit une bannière scrcpy 4.1', () => {
  const v = device.parseVersion(fixture('scrcpy-version-4.1.txt'));
  assert.deepStrictEqual(v, { major: 4, minor: 1, release: '4.1' });
});

test('parseVersion refuse une bannière sans numéro', () => {
  assert.strictEqual(device.parseVersion('pas un binaire scrcpy\n'), null);
  assert.strictEqual(device.parseVersion(''), null);
});

// ── parseAppLine ────────────────────────────────────────────────────────────

test('parseAppLine lit la sortie de scrcpy --list-apps', () => {
  const lines = fixture('scrcpy-list-apps.txt').split('\n');
  const apps = lines.map(device.parseAppLine).filter(Boolean);
  assert.strictEqual(apps.length, 4);

  assert.deepStrictEqual(apps[0], {
    name: 'AR Zone',
    package: 'com.samsung.android.arzone',
    system: true,
  });
  assert.strictEqual(apps[2].system, false, 'le préfixe " - " marque une app utilisateur');
  assert.strictEqual(apps[2].package, 'com.aura.testapp');
});

test('parseAppLine gère un nom contenant des espaces multiples', () => {
  const app = device.parseAppLine(' * WhatsApp   com.whatsapp');
  assert.strictEqual(app.name, 'WhatsApp');
  assert.strictEqual(app.package, 'com.whatsapp');
});

test('parseAppLine ignore les lignes de journal', () => {
  assert.strictEqual(device.parseAppLine('[server] INFO: List of apps:'), null);
  assert.strictEqual(device.parseAppLine(''), null);
});

// ── parseNotifications ──────────────────────────────────────────────────────

test('parseNotifications extrait paquet, titre et texte, plus récentes d’abord', () => {
  const items = device.parseNotifications(fixture('dumpsys-notification.txt'));
  // La troisième notification (routines) n’a ni titre ni texte : le parseur
  // l’écarte volontairement, rien de visible à en tirer.
  assert.strictEqual(items.length, 2);
  // Tri décroissant sur `when` : le message Gmail (…001) passe avant WhatsApp (…000).
  assert.strictEqual(items[0].package, 'com.google.android.gm');
  assert.strictEqual(items[0].when, 1718000001000);
  assert.strictEqual(items[1].package, 'com.whatsapp');
  assert.strictEqual(items[1].title, 'Alice');
  assert.strictEqual(items[1].text, 'Salut, tu es là ?');
});

test('parseNotifications aplatit un titre multiligne', () => {
  const items = device.parseNotifications(fixture('dumpsys-notification.txt'));
  // Le nettoyage remplace les sauts de ligne par des espaces : un titre de
  // volet ne doit jamais contenir de retour chariot.
  assert.strictEqual(items[0].title, 'Trois nouveaux messages sur deux lignes');
});

test('parseNotifications écarte un enregistrement sans titre ni texte', () => {
  const items = device.parseNotifications(fixture('dumpsys-notification.txt'));
  assert.ok(items.every((n) => n.package !== 'com.samsung.android.app.routines'));
});

test('parseNotifications répond du vide sur un dump sans notification', () => {
  assert.deepStrictEqual(device.parseNotifications('Current Notification Manager state:\n  None\n'), []);
  assert.deepStrictEqual(device.parseNotifications(''), []);
});

// ── parseDisplayId ──────────────────────────────────────────────────────────

test('parseDisplayId lit la ligne « New display » du serveur', () => {
  assert.strictEqual(device.parseDisplayId('[server] INFO: New display: 1280x800/160 (id=38)'), 38);
  assert.strictEqual(device.parseDisplayId('[server] INFO: rien à voir ici'), null);
});

// ── parseScanLine ───────────────────────────────────────────────────────────

test('parseScanLine lit les résultats de scan Wi-Fi', () => {
  const lines = fixture('wifi-scan-results.txt').split('\n');
  const points = lines.map(device.parseScanLine).filter(Boolean);
  assert.strictEqual(points.length, 3);

  assert.strictEqual(points[0].ssid, 'MonReseau');
  assert.strictEqual(points[0].band, '2,4 GHz');
  assert.strictEqual(points[0].rssi, -52);
  assert.strictEqual(points[1].band, '5 GHz');
});

test('parseScanLine ignore entête et lignes incomplètes', () => {
  assert.strictEqual(device.parseScanLine('BSSID              Frequency  RSSI'), null);
  assert.strictEqual(device.parseScanLine(''), null);
});

// ── supportedOptions + filterArgs ───────────────────────────────────────────
// Régression directe du bug LMDE : une 3.3.4 doit perdre --flex-display et
// --keep-active sans que scrcpy ne meure sur « unrecognized option ».

const supportedOf = (fixtureName) => {
  const text = fixture(fixtureName);
  const options = new Set();
  for (const m of text.matchAll(/(^|\s)--([a-z0-9-]+)/g)) options.add(`--${m[2]}`);
  return options;
};

test('supportedOptions voit --flex-display dans la 4.1, pas dans la 3.3.4', () => {
  assert.ok(supportedOf('scrcpy-help-4.1.txt').has('--flex-display'));
  assert.ok(!supportedOf('scrcpy-help-3.3.4.txt').has('--flex-display'));
});

test('filterArgs retire les options inconnues et note chaque retrait', () => {
  const supported = supportedOf('scrcpy-help-3.3.4.txt');
  const notes = [];
  const kept = device.filterArgs(
    ['--serial', 'ABC', '--new-display=1280x800/160', '--flex-display', '--keep-active', '--window-title=X'],
    supported,
    notes
  );
  assert.deepStrictEqual(kept, ['--serial', 'ABC', '--new-display=1280x800/160', '--window-title=X']);
  assert.strictEqual(notes.length, 2);
  assert.match(notes[0], /--flex-display/);
  assert.match(notes[1], /--keep-active/);
});

test('filterArgs emporte la valeur d\u2019une option à argument séparé', () => {
  const supported = new Set(['--window-title']);
  const notes = [];
  const kept = device.filterArgs(['--option-inconnue', 'valeur', '--window-title', 'X'], supported, notes);
  assert.deepStrictEqual(kept, ['--window-title', 'X'], 'la valeur de l\u2019option retirée ne doit pas rester orpheline');
});

test('filterArgs ne touche à rien quand tout est supporté', () => {
  const supported = supportedOf('scrcpy-help-4.1.txt');
  const notes = [];
  const args = ['--serial', 'ABC', '--flex-display', '--keep-active'];
  assert.deepStrictEqual(device.filterArgs(args, supported, notes), args);
  assert.strictEqual(notes.length, 0);
});

// ── sessionArgs ─────────────────────────────────────────────────────────────

test('sessionArgs construit une session application complète', () => {
  const args = device.sessionArgs('ABC', { package: 'com.example.app', name: 'Exemple' }, {
    width: 1280, height: 800, dpi: 160,
    keepActive: true, noSystemDecorations: true,
    codec: 'h265', bitrate: '8M', maxFps: 60, audio: false,
  });
  assert.ok(args.includes('--serial'));
  assert.ok(args.includes('ABC'));
  assert.ok(args.includes('--new-display=1280x800/160'));
  assert.ok(args.includes('--start-app=com.example.app'));
  assert.ok(args.includes('--keep-active'));
  assert.ok(args.includes('--no-vd-system-decorations'));
  assert.ok(args.includes('--no-audio'));
  assert.ok(!args.includes('--flex-display'), 'flex désactivé : pas de --flex-display');
});

test('sessionArgs choisit fenêtre OU flex, jamais les deux', () => {
  const base = { width: 1280, height: 800, dpi: 160, codec: 'h264', audio: true };
  const flex = device.sessionArgs(null, { package: 'p', name: 'n' }, { ...base, flex: true, windowWidth: 700 });
  assert.ok(flex.includes('--flex-display'));
  assert.ok(!flex.some((a) => a.startsWith('--window-width') || a.startsWith('--window-height')));

  const fixed = device.sessionArgs(null, { package: 'p', name: 'n' }, { ...base, flex: false, windowWidth: 700 });
  assert.ok(fixed.includes('--window-width=700'));
  assert.ok(!fixed.includes('--flex-display'));
});

test('sessionArgs construit un miroir sans écran virtuel', () => {
  const args = device.sessionArgs('ABC', { package: null, name: 'Téléphone' }, {
    mirror: true, windowHeight: 538, codec: 'h265', bitrate: '24M', maxFps: 120, audio: false,
  });
  assert.ok(args.includes('--window-height=538'));
  assert.ok(!args.includes('--new-display'), 'le miroir recopie l\u2019écran existant');
  assert.ok(!args.includes('--start-app'));
});

// ── explain ─────────────────────────────────────────────────────────────────

test('explain traduit les erreurs scrcpy connues', () => {
  assert.match(device.explain('ERROR: Could not create display'), /écran virtuel/);
  assert.match(device.explain('device unauthorized'), /autoris/);
  assert.strictEqual(device.explain('erreur totalement inconnue'), null);
});
