'use strict';
// Validation des réglages, et géométrie des fenêtres.
//
// Ces deux morceaux n'avaient aucune couverture. Le premier est une frontière de
// confiance : la page écrit dans le magasin, et plusieurs de ces réglages
// finissent sur la ligne de commande de scrcpy. Le second est de l'arithmétique
// à deux branches que personne ne relit sans se tromper.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store, DEFAULTS, nettoyer } = require('../src/store');
const layout = require('../src/layout');

/// Un magasin sur un fichier jetable.
function magasin(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  return { store: new Store(file), file };
}

// ── Ce qui entre, et ce qui n'entre pas ─────────────────────────────────────

test('une clé inconnue n’entre pas dans le magasin', (t) => {
  const { store } = magasin(t);
  store.set({ méchant: 'oui', pinned: false });
  assert.strictEqual('méchant' in store.all, false);
  assert.strictEqual(store.get('pinned'), false, 'le reste du patch passe quand même');
});

test('un codec inventé est refusé, un codec connu passe', (t) => {
  const { store } = magasin(t);
  store.set({ codec: 'quelque chose; rm -rf /' });
  assert.strictEqual(store.get('codec'), DEFAULTS.codec);
  store.set({ codec: 'h265' });
  assert.strictEqual(store.get('codec'), 'h265');
});

test('une définition hors bornes est refusée', (t) => {
  const { store } = magasin(t);
  store.set({ width: 99999, height: 0, dpi: 240 });
  assert.strictEqual(store.get('width'), DEFAULTS.width);
  assert.strictEqual(store.get('height'), DEFAULTS.height);
  assert.strictEqual(store.get('dpi'), 240, 'la valeur valide du même patch est retenue');
});

test('le débit n’accepte que les formes que scrcpy comprend', (t) => {
  const { store } = magasin(t);
  for (const bon of ['8M', '2000K', '4000000']) {
    store.set({ bitrate: bon });
    assert.strictEqual(store.get('bitrate'), bon);
  }
  store.set({ bitrate: '8M --no-audio' });
  assert.strictEqual(store.get('bitrate'), '4000000', 'la dernière valeur valide tient');
});

test('le composeur doit ressembler à un nom de paquet', (t) => {
  const { store } = magasin(t);
  store.set({ dialer: '../../etc/passwd' });
  assert.strictEqual(store.get('dialer'), DEFAULTS.dialer);
  store.set({ dialer: 'com.google.android.dialer' });
  assert.strictEqual(store.get('dialer'), 'com.google.android.dialer');
});

test('les favoris sont filtrés un par un, sans rejeter la liste entière', (t) => {
  const { store } = magasin(t);
  store.set({ favorites: ['com.a.b', '', '../x', 'com.c.d', 'com.a.b'] });
  assert.deepStrictEqual(store.get('favorites'), ['com.a.b', 'com.c.d']);
});

test('une bascule n’accepte qu’un vrai booléen', (t) => {
  const { store } = magasin(t);
  // « 'false' » est une chaîne, et toute chaîne non vide est vraie en
  // JavaScript : l'accepter inverserait silencieusement le réglage.
  store.set({ pinned: 'false' });
  assert.strictEqual(store.get('pinned'), DEFAULTS.pinned);
});

test('les surcharges par application sont validées comme les réglages généraux', (t) => {
  const { store } = magasin(t);
  store.setOverride('com.facebook.katana', { captureOrientation: '0', codec: 'inconnu' });
  assert.deepStrictEqual(store.overrideFor('com.facebook.katana'), { captureOrientation: '0' });

  // Un paquet qui n'en est pas un n'ouvre pas d'entrée.
  assert.strictEqual(store.setOverride('pas un paquet !', { flex: true }), null);
  assert.deepStrictEqual(store.overrideFor('pas un paquet !'), {});
});

test('un fichier de configuration corrompu ne fait pas tomber le démarrage', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');

  // Écrit à la main, ou par une version dont les réglages ont changé de forme.
  fs.writeFileSync(file, JSON.stringify({ codec: 'nawak', width: 1600, hérité: true }));
  const store = new Store(file);
  assert.strictEqual(store.get('codec'), DEFAULTS.codec, 'la valeur douteuse est écartée');
  assert.strictEqual(store.get('width'), 1600, 'la valeur valide est reprise');
  assert.strictEqual('hérité' in store.all, false, 'la clé oubliée ne survit pas');
});

// ── Écritures inutiles ──────────────────────────────────────────────────────

test('reposer la même valeur ne réécrit pas le fichier', (t) => {
  const { store, file } = magasin(t);
  // `connect()` repose le même numéro de série à chaque reconnexion — toutes les
  // minutes. Sans ce filtre, le fichier était réécrit à chaque passage.
  store.set({ serial: 'R58M80ABCDE' });
  const avant = fs.statSync(file).mtimeMs;
  const taille = fs.statSync(file).size;

  store.set({ serial: 'R58M80ABCDE' });
  store.set({ favorites: [] });

  const après = fs.statSync(file);
  assert.strictEqual(après.mtimeMs, avant, 'aucune réécriture');
  assert.strictEqual(après.size, taille);
});

test('un numéro de série d’appareil réseau est accepté', (t) => {
  const { store } = magasin(t);
  store.set({ serial: '192.168.1.42:5555' });
  assert.strictEqual(store.get('serial'), '192.168.1.42:5555');
});

test('nettoyer laisse le patch vide quand rien n’est acceptable', () => {
  assert.deepStrictEqual(nettoyer({ inconnu: 1, codec: 'nope' }), {});
});

// ── Géométrie ───────────────────────────────────────────────────────────────

// Un écran de portable ordinaire, barre des tâches déduite.
const ECRAN = { width: 1920, height: 1040 };

test('sizing ne touche à rien quand la fenêtre tient déjà dans sa part', () => {
  // 1280 × 800 à 100 % d'un écran 1920 × 1040 : scrcpy n'a rien à mettre à
  // l'échelle, et une option en moins est une option qui ne peut pas être
  // refusée par une vieille version.
  assert.deepStrictEqual(layout.sizing({ width: 1280, height: 800, windowScale: 1 }, ECRAN), {});
});

test('sizing ne contraint qu’une dimension, pour garder le rapport', () => {
  // Deux dimensions imposées donneraient des bandes noires dès que le rapport
  // de la fenêtre diffère de celui de l'écran virtuel.
  const r = layout.sizing({ width: 1280, height: 800, windowScale: 0.55 }, ECRAN);
  assert.strictEqual(Object.keys(r).length, 1);
  assert.ok(r.windowWidth || r.windowHeight);
});

test('sizing suit la dimension la plus serrée', () => {
  // Écran large et bas : c'est la hauteur qui limite, donc c'est elle qu'on
  // impose — l'inverse déborderait vers le bas.
  const r = layout.sizing({ width: 1280, height: 800, windowScale: 0.55 }, { width: 3440, height: 900 });
  assert.ok(r.windowHeight, 'la hauteur commande');
  assert.strictEqual(r.windowWidth, undefined);
});

test('sizing en mode « suivre la fenêtre » réduit la densité avec la définition', () => {
  // C'est tout l'enjeu : à densité constante, un écran virtuel plus petit fait
  // croire à Android qu'il dessine sur un tout petit téléphone, et il grossit
  // tout au lieu de rétrécir.
  const base = { width: 1280, height: 800, dpi: 160, flex: true, windowScale: 0.55 };
  const r = layout.sizing(base, ECRAN);

  const facteur = r.width / 1280;
  assert.ok(facteur < 1, 'la définition est réduite');
  // La densité suit le facteur, à l'arrondi près : la définition est ramenée à
  // un nombre pair pour l'encodeur, la densité ne l'est pas.
  assert.ok(Math.abs(r.dpi - 160 * facteur) <= 1, `densité ${r.dpi} pour un facteur ${facteur}`);

  // Ce qui compte vraiment : le même nombre de « dp », donc la même mise en page
  // Android, simplement dessinée sur moins de pixels.
  const dpLargeur = (r.width * 160) / r.dpi;
  const dpHauteur = (r.height * 160) / r.dpi;
  assert.ok(Math.abs(dpLargeur - 1280) / 1280 < 0.01, `largeur ${Math.round(dpLargeur)} dp au lieu de 1280`);
  assert.ok(Math.abs(dpHauteur - 800) / 800 < 0.01, `hauteur ${Math.round(dpHauteur)} dp au lieu de 800`);
});

test('sizing en mode flex rend des dimensions paires', () => {
  // Les encodeurs vidéo matériels refusent les dimensions impaires.
  for (const scale of [0.25, 0.33, 0.4, 0.55, 0.7, 0.85]) {
    const r = layout.sizing({ width: 1280, height: 800, dpi: 160, flex: true, windowScale: scale }, ECRAN);
    assert.strictEqual(r.width % 2, 0, `largeur paire à ${scale}`);
    assert.strictEqual(r.height % 2, 0, `hauteur paire à ${scale}`);
  }
});

test('sizing en mode flex garde 360 dp sur le petit côté', () => {
  // En dessous, une mise en page Android n'a plus de sens. Le plancher agit sur
  // le facteur et non sur chaque dimension, sinon la forme se déformerait.
  const r = layout.sizing(
    { width: 1280, height: 800, dpi: 160, flex: true, windowScale: 0.25 },
    { width: 800, height: 600 }
  );
  assert.ok(Math.min(r.width, r.height) >= 360, `petit côté = ${Math.min(r.width, r.height)}`);
  assert.ok(Math.abs(r.width / r.height - 1280 / 800) < 0.02, 'le rapport est préservé');
});

test('sizing borne la part d’écran demandée', () => {
  // `windowScale` vient des réglages : hors bornes, il est ramené dans l'intervalle
  // au lieu de produire une fenêtre absurde.
  const énorme = layout.sizing({ width: 1280, height: 800, windowScale: 12 }, ECRAN);
  const minuscule = layout.sizing({ width: 1280, height: 800, windowScale: -3 }, ECRAN);
  assert.deepStrictEqual(énorme, layout.sizing({ width: 1280, height: 800, windowScale: 1 }, ECRAN));
  assert.deepStrictEqual(minuscule, layout.sizing({ width: 1280, height: 800, windowScale: 0.25 }, ECRAN));
});
