'use strict';
// Harnais jsdom : charge index.html + app.js avec un window.aura factice, et
// pilote l'interface par événements réels. Objectif : que les bugs d'interaction
// (menu refermé à l'instant où il s'ouvre, pastille rognée…) soient vus ici et
// plus seulement à la main.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'ui', 'index.html'), 'utf8')
  // Le <script src> externe n'est pas résolu par jsdom sans ressources : on
  // évalue app.js nous-mêmes, après avoir posé les stubs.
  .replace('<script src="app.js"></script>', '');

const appJs = fs.readFileSync(path.join(root, 'ui', 'app.js'), 'utf8');

const SETTINGS = {
  favorites: [], pinned: true, width: 1280, height: 800, dpi: 160,
  flex: false, keepActive: true, audio: false, codec: 'h264', bitrate: '8M',
  maxFps: 60, noSystemDecorations: false, windowScale: 0.55,
  alwaysOnTop: false, hideAfterLaunch: false, blurWallpaper: false,
  showSystemApps: false, desktopNotifications: false, raiseOnCall: true,
  mirrorOnCall: false, autoUpdate: false,
};

/// Une instance de l'interface, avec un pont `aura` qui enregistre les ordres.
async function makeApp(t, overrides = {}) {
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  // Sans ça, les intervalles d'app.js gardent la boucle d'événements vivante
  // et le processus de test ne se termine jamais.
  t.after(() => dom.window.close());

  const { window } = dom;

  const calls = [];
  const ok = (value) => () => Promise.resolve(value);
  const aura = {
    bootstrap: ok({ settings: SETTINGS, device: { serial: 'TEST', model: 'Test', android: '14', battery: 80, charging: false }, engine: null, error: null, apps: [], collectedAt: null, version: 'test', sessions: [] }),
    refreshDevice: () => { calls.push(['refreshDevice']); return Promise.resolve({ device: { serial: 'TEST', model: 'Test', android: '14', battery: 80, charging: false }, error: null, apps: [], collectedAt: null }); },
    refreshApps: ok({ apps: [], collectedAt: null }),
    engineTarget: ok(null),
    callState: ok(null),
    sessions: ok([]),
    notifications: ok([]),
    notificationKeys: ok([]),
    quickState: ok(null),
    devices: ok([]),
    selectDevice: ok({ device: null, error: null, apps: [], collectedAt: null }),
    saveSettings: (patch) => { calls.push(['saveSettings', patch]); return Promise.resolve({ ...SETTINGS, ...patch }); },
    hide: () => { calls.push(['hide']); return Promise.resolve(); },
    openMirror: () => { calls.push(['openMirror']); return Promise.resolve(); },
    openDiagnostic: () => { calls.push(['openDiagnostic']); return Promise.resolve(); },
    fit: ok(undefined),
    ...overrides,
  };
  // Les canaux d'événements : on retient les abonnés pour les déclencher.
  aura._subscribers = {};
  for (const channel of ['onNotifications', 'onSessions', 'onUpdate', 'onCall', 'onFailure', 'onShown', 'onEngineProgress', 'onWallpaper', 'onTransfer']) {
    aura[channel] = (fn) => { (aura._subscribers[channel] ||= []).push(fn); };
  }
  window.aura = aura;

  window.eval(appJs);
  // Laisse boot() et ses micro-tâches se dérouler.
  await new Promise((r) => setTimeout(r, 30));

  return { dom, window, aura, calls };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

/// Clic réaliste : bulle jusqu'au document, comme un vrai clic de souris.
const click = (window, el) =>
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

// ── Centre de contrôle ──────────────────────────────────────────────────────

test('le menu ⋯ s\u2019ouvre au clic et RESTE ouvert (régression : refermé par son propre clic)', async (t) => {
  const { window } = await makeApp(t);
  click(window, window.document.getElementById('btnControl'));
  await tick();

  const menu = window.document.querySelector('.menu.control');
  assert.ok(menu, 'le centre de contrôle doit être ouvert après le clic');
  assert.ok(menu.isConnected, 'et ne doit pas avoir été refermé par la propagation du clic');
});

test('un clic passif dans le menu ne le referme pas ; un clic dehors oui', async (t) => {
  const { window } = await makeApp(t);
  const doc = window.document;
  click(window, doc.getElementById('btnControl'));
  await tick();
  assert.ok(doc.querySelector('.menu.control'));

  // Clic sur une partie non actionnable du menu (l'étiquette d'une ligne) :
  // le menu reste. C'est exactement le bug déjà vu : le clic remontait au
  // document, qui fermait tout menu dont la cible était « dehors ».
  const label = doc.querySelector('.menu.control .control-label');
  click(window, label);
  await tick();
  assert.ok(doc.querySelector('.menu.control'), 'un clic interne ne ferme pas le menu');

  // Clic ailleurs : le menu se ferme.
  click(window, doc.body);
  await tick();
  assert.strictEqual(doc.querySelector('.menu.control'), null);
});

test('Échap referme le menu avant de masquer la fenêtre', async (t) => {
  const { window, calls } = await makeApp(t);
  const doc = window.document;
  click(window, doc.getElementById('btnControl'));
  await tick();
  assert.ok(doc.querySelector('.menu.control'));

  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick();
  assert.strictEqual(doc.querySelector('.menu.control'), null, 'le menu est fermé');
  assert.ok(!calls.some(([name]) => name === 'hide'), 'la fenêtre, elle, reste ouverte');
});

test('un item du menu se referme et exécute son action', async (t) => {
  const { window, calls } = await makeApp(t);
  const doc = window.document;
  click(window, doc.getElementById('btnControl'));
  await tick();

  const item = [...doc.querySelectorAll('.menu.control .menu-item')]
    .find((el) => el.textContent.includes('Écran du téléphone'));
  click(window, item);
  await tick();

  assert.strictEqual(doc.querySelector('.menu.control'), null, 'l\u2019item referme le menu');
  assert.ok(calls.some(([name]) => name === 'openMirror'), 'et lance l\u2019action correspondante');
});

// ── Sélecteur d'appareils ───────────────────────────────────────────────

test('un seul appareil : le pilote relance la connexion, pas de menu', async (t) => {
  const { window, calls } = await makeApp(t, {
    devices: () => Promise.resolve([{ serial: 'A', model: 'Téléphone A', current: true }]),
  });
  click(window, window.document.getElementById('device'));
  await tick();
  assert.strictEqual(window.document.querySelector('.menu'), null, 'pas de sélecteur pour un appareil unique');
  assert.ok(calls.some(([name]) => name === 'refreshDevice'), 'reconnexion directe');
});

test('deux appareils : le pilote ouvre le sélecteur et bascule', async (t) => {
  const liste = [
    { serial: 'AAA', model: 'Téléphone A', current: true },
    { serial: 'BBB', model: 'Téléphone B', current: false },
  ];
  const { window, calls } = await makeApp(t, {
    devices: () => Promise.resolve(liste),
    selectDevice: (serial) => {
      calls.push(['selectDevice', serial]);
      liste.forEach((d) => { d.current = d.serial === serial; });
      return Promise.resolve({ device: { serial, model: 'Téléphone B', battery: 50, charging: false }, error: null, apps: [], collectedAt: 1 });
    },
  });
  const doc = window.document;

  click(window, doc.getElementById('device'));
  await tick();

  const items = [...doc.querySelectorAll('.menu .menu-item')];
  assert.strictEqual(items.length, 2, 'les deux appareils sont listés');
  assert.ok(items[0].className.includes('checked'), 'l\'appareil actif est marqué');

  click(window, items[1]);
  await tick();
  assert.ok(calls.some(([name, arg]) => name === 'selectDevice' && arg === 'BBB'), 'la bascule demande le bon numéro de série');
  assert.strictEqual(doc.getElementById('deviceName').textContent, 'Téléphone B', 'l\'interface montre le nouvel appareil');
});

// ── Utilitaires ─────────────────────────────────────────────────────────

test('le bouton notifications ouvre le volet, le referme au second clic', async (t) => {
  const { window } = await makeApp(t);
  const doc = window.document;
  const btn = doc.getElementById('btnNotifs');

  click(window, btn);
  await tick();
  assert.strictEqual(doc.getElementById('panelNotifs').hidden, false);

  click(window, btn);
  await tick();
  assert.strictEqual(doc.getElementById('panelNotifs').hidden, true);
});

test('le bouton masquer prévient le processus principal', async (t) => {
  const { window, calls } = await makeApp(t);
  click(window, window.document.getElementById('btnClose'));
  await tick();
  assert.ok(calls.some(([name]) => name === 'hide'));
});

test('le centre de contrôle contient épinglage, miroir et réglages', async (t) => {
  const { window } = await makeApp(t);
  click(window, window.document.getElementById('btnControl'));
  await tick();

  const labels = [...window.document.querySelectorAll('.menu.control .menu-item span')].map((s) => s.textContent);
  assert.ok(labels.includes('Écran du téléphone'));
  assert.ok(labels.includes('Épingler la fenêtre'));
  assert.ok(labels.includes('Réglages'));
});

// ── Indicateurs de connectivité ─────────────────────────────────────────────

test('renderNet allume, éteint et alerte selon l\u2019état des radios', async (t) => {
  const { window } = await makeApp(t);
  const doc = window.document;

  // On pilote la fonction de rendu par la même voie que l'application : le
  // canal d'événements « shown », qui déclenche un sondage complet.
  const net = { wifi: true, wifiConnected: true, bluetooth: false, airplane: false, mobileData: false, dnd: false };
  const { aura } = { aura: window.aura };
  aura.quickState = () => Promise.resolve({ net, volume: { value: 6, max: 15 }, ringer: 'normal', dnd: false });

  // pollQuick n'est pas exporté : on repasse par le chemin applicatif réel,
  // l'ouverture du centre de contrôle, qui rafraîchit l'état puis l'affiche.
  click(window, doc.getElementById('btnControl'));
  await tick();

  const wifi = doc.getElementById('netWifi');
  assert.strictEqual(wifi.classList.contains('off'), false, 'Wi-Fi actif : pas estompé');
  assert.strictEqual(wifi.classList.contains('live'), true, 'Wi-Fi connecté : point vif');
  assert.strictEqual(doc.getElementById('netBt').classList.contains('off'), true, 'Bluetooth éteint : estompé');
  assert.strictEqual(doc.getElementById('netPlane').hidden, true, 'Pas de mode avion : icône masquée');
});
