'use strict';
// Détection de la session graphique.
//
// C'est elle qui décide si Aura peut piloter les fenêtres de scrcpy, et par
// quel chemin. Se tromper ici ne produit pas une erreur : la fonctionnalité
// disparaît en silence — les vignettes de session cessent simplement de
// répondre au clic. D'où ces tests, écrits sur une machine X11 pour un
// comportement qui ne se voit que sous Wayland.

const test = require('node:test');
const assert = require('node:assert');

const session = require('../src/session');

const X11 = { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' };
const WAYLAND = { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':1' };
const WAYLAND_PUR = { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' };

// ── Type de session ─────────────────────────────────────────────────────────

test('sessionType croit XDG_SESSION_TYPE quand il est renseigné', () => {
  assert.strictEqual(session.sessionType(X11), 'x11');
  assert.strictEqual(session.sessionType(WAYLAND), 'wayland');
});

test('sessionType se rabat sur les variables d’affichage', () => {
  // Une session lancée depuis un gestionnaire qui n'exporte pas
  // `XDG_SESSION_TYPE` — cela arrive avec startx et quelques gestionnaires
  // légers.
  assert.strictEqual(session.sessionType({ WAYLAND_DISPLAY: 'wayland-0' }), 'wayland');
  assert.strictEqual(session.sessionType({ DISPLAY: ':0' }), 'x11');
  assert.strictEqual(session.sessionType({}), 'inconnue');
});

test('sessionType préfère Wayland quand les deux sont là', () => {
  // Une session Wayland fait tourner XWayland, donc `DISPLAY` est renseigné
  // **aussi**. Conclure « x11 » parce que `DISPLAY` existe serait l'erreur
  // exacte que ce module est là pour éviter.
  assert.strictEqual(session.sessionType({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':1' }), 'wayland');
});

// ── Pilote vidéo imposé à scrcpy ────────────────────────────────────────────

test('videoDriver ne touche à rien sous X11', () => {
  // Rien à corriger : SDL choisira x11 de lui-même.
  assert.strictEqual(session.videoDriver({ env: X11 }), null);
});

test('videoDriver force x11 sous Wayland', () => {
  // Laissé libre, SDL 2.0.22+ choisit Wayland, et la fenêtre devient invisible
  // à wmctrl comme à xdotool.
  assert.strictEqual(session.videoDriver({ env: WAYLAND }), 'x11');
});

test('videoDriver respecte le réglage désactivé', () => {
  assert.strictEqual(session.videoDriver({ env: WAYLAND, xwayland: false }), null);
});

test('AURA_SDL_VIDEODRIVER a le dernier mot', () => {
  // La porte de sortie pour qui veut trancher sans passer par l'interface —
  // y compris pour choisir un pilote qu'Aura ne propose pas.
  assert.strictEqual(
    session.videoDriver({ env: { ...WAYLAND, AURA_SDL_VIDEODRIVER: 'wayland' } }),
    'wayland'
  );
  assert.strictEqual(
    session.videoDriver({ env: { ...X11, AURA_SDL_VIDEODRIVER: 'kmsdrm' } }),
    'kmsdrm'
  );
});

// ── Pilotage des fenêtres ───────────────────────────────────────────────────

test('windowControl : X11 marche directement', () => {
  assert.deepStrictEqual(session.windowControl({ platform: 'linux', env: X11 }), { possible: true, via: 'x11' });
});

test('windowControl : Wayland passe par XWayland', () => {
  const v = session.windowControl({ platform: 'linux', env: WAYLAND });
  assert.strictEqual(v.possible, true);
  assert.strictEqual(v.via, 'xwayland', 'le diagnostic doit pouvoir le dire');
});

test('windowControl : Wayland sans XWayland est honnête sur son impuissance', () => {
  // Pas de `DISPLAY` : aucun serveur X joignable, donc aucune fenêtre
  // pilotable. Mieux vaut le dire que laisser les vignettes muettes.
  const v = session.windowControl({ platform: 'linux', env: WAYLAND_PUR });
  assert.strictEqual(v.possible, false);
  assert.match(v.raison, /XWayland/);
});

test('windowControl : Wayland avec le réglage coupé explique où le rallumer', () => {
  const v = session.windowControl({ platform: 'linux', env: WAYLAND, xwayland: false });
  assert.strictEqual(v.possible, false);
  assert.match(v.raison, /réglages/i, 'le message doit dire quoi faire');
});

test('windowControl : hors Linux, on ne prétend rien', () => {
  for (const platform of ['win32', 'darwin']) {
    const v = session.windowControl({ platform, env: X11 });
    assert.strictEqual(v.possible, false);
    assert.match(v.raison, new RegExp(platform));
  }
});

// ── Photographie du bureau ──────────────────────────────────────────────────

test('wallpaperCapture s’abstient sous Wayland', () => {
  // Le portail demande une autorisation à chaque prise, et le fond se prend à
  // chaque apparition du widget : ce serait une boîte de dialogue par appui sur
  // le raccourci.
  const v = session.wallpaperCapture({ env: WAYLAND });
  assert.strictEqual(v.possible, false);
  assert.match(v.raison, /autorisation/);
  assert.strictEqual(session.wallpaperCapture({ env: X11 }).possible, true);
});
