'use strict';
// Le mode bureau : le téléphone comme unité centrale.
//
// Le widget est un lanceur posé sur *votre* bureau. Le mode bureau est l'inverse :
// un plein écran où le téléphone devient la machine — fond d'écran, icônes,
// widgets, et les applications Android logées dedans comme les fenêtres d'un
// système d'exploitation.
//
// Ce qui rend cela possible tient dans `embed.js` : les fenêtres de scrcpy y sont
// reparentées dans celle du bureau. Une conséquence gouverne toute la mise en
// page, et il faut l'avoir en tête pour comprendre le code :
//
//   **Une fenêtre X11 enfant est dessinée par le serveur X, au-dessus de tout ce
//   que Chromium peint.** Le HTML ne peut donc jamais passer par-dessus une
//   application logée. La barre de titre d'une fenêtre n'est pas dessinée
//   *sur* elle mais *au-dessus* d'elle, dans la bande que la surface Android ne
//   couvre pas. Même chose pour la barre des tâches : les fenêtres sont bornées
//   à la zone libre.
//
// Là où le reparentage est impossible — Wayland sans XWayland, python-xlib
// absent — le bureau ne s'effondre pas : il garde fond d'écran, widgets et
// lanceur, et les applications s'ouvrent en fenêtres flottantes comme
// d'habitude. Dégradé, pas cassé.

const { BrowserWindow, screen } = require('electron');
const path = require('path');

const embed = require('./embed');
const session = require('./session');
const log = require('./log');

/// Hauteur de la barre de titre d'une fenêtre logée, en pixels CSS.
/// Le HTML la dessine ; la surface Android commence en dessous.
const TITRE = 34;

/// Hauteur de la barre des tâches, en bas.
const BARRE = 56;

let bureau = null;
/// sessionId → { xid, boite, titre, package }
const logees = new Map();
let praticabilite = null;
let deps = null;

const ouvert = () => Boolean(bureau && !bureau.isDestroyed());

/// Le facteur d'échelle de l'écran qui porte le bureau.
///
/// Le rendu raisonne en pixels CSS, X11 en pixels physiques. Sur un écran à
/// 200 %, ignorer la conversion placerait chaque fenêtre au quart de sa taille,
/// dans le coin supérieur gauche.
function echelle() {
  if (!ouvert()) return 1;
  const b = bureau.getBounds();
  return screen.getDisplayNearestPoint({ x: b.x, y: b.y }).scaleFactor || 1;
}

/// Traduit une boîte du rendu vers les coordonnées du serveur X.
function versX11(boite) {
  const k = echelle();
  return {
    x: Math.round(boite.x * k),
    y: Math.round(boite.y * k),
    w: Math.max(1, Math.round(boite.w * k)),
    h: Math.max(1, Math.round(boite.h * k)),
  };
}

/// L'identifiant X11 de la fenêtre du bureau.
function xidBureau() {
  if (!ouvert()) return null;
  try {
    return `0x${bureau.getNativeWindowHandle().readUInt32LE(0).toString(16)}`;
  } catch (_) {
    return null;
  }
}

async function praticable() {
  if (praticabilite) return praticabilite;
  praticabilite = await embed.praticable(
    session.windowControl({ xwayland: deps.store.get('xwayland') !== false })
  );
  return praticabilite;
}

// ── Fenêtre ─────────────────────────────────────────────────────────────────

function ouvrir(dependances) {
  deps = dependances || deps;
  if (ouvert()) {
    bureau.show();
    bureau.focus();
    return bureau;
  }

  const ecran = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  bureau = new BrowserWindow({
    ...ecran.workArea,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Aura — Bureau',
    backgroundColor: '#0b0d15',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload-desktop.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  bureau.loadFile(path.join(__dirname, '..', 'ui', 'desktop.html'));
  bureau.once('ready-to-show', () => { bureau.show(); bureau.maximize(); });

  // Une fenêtre logée ne suit pas son parent toute seule : le rendu recalcule
  // les positions et nous les repose.
  bureau.on('resize', () => envoyer('desktop:resized'));

  bureau.on('closed', () => {
    // Rendre les fenêtres au système plutôt que de les emporter : l'utilisateur
    // ferme un bureau, pas ses applications.
    for (const [, info] of logees) embed.release(info.xid).catch(() => {});
    logees.clear();
    bureau = null;
    if (deps && deps.onFermé) deps.onFermé();
  });

  return bureau;
}

function fermer() {
  if (ouvert()) bureau.close();
}

function envoyer(canal, charge) {
  if (ouvert()) bureau.webContents.send(canal, charge);
}

// ── Loger les fenêtres ──────────────────────────────────────────────────────

/// Accueille une session dans le bureau.
///
/// Rendue `false` si le reparentage n'est pas possible : l'appelant sait alors
/// que la fenêtre restera flottante, et le rendu l'annonce plutôt que d'afficher
/// un cadre vide qui ne contiendrait rien.
async function accueillir(sess, boite) {
  if (!ouvert() || !sess || !sess.child) return false;
  const verdict = await praticable();
  if (!verdict.ok) return false;

  const parent = xidBureau();
  if (!parent) return false;

  const xid = await embed.attendreFenetre(sess.child.pid, 25000);
  if (!xid) {
    log.warn(`bureau : fenêtre introuvable pour ${sess.package}`);
    return false;
  }

  const px = versX11(boite);
  const r = await embed.reparent(xid, parent, px.x, px.y, px.w, px.h);
  if (!r.ok) {
    log.warn(`bureau : ancrage refusé pour ${sess.package} — ${r.error}`);
    return false;
  }

  logees.set(sess.id, { xid, boite, package: sess.package, titre: sess.name });
  log.info(`bureau : ${sess.package} logée (${xid})`);
  return true;
}

/// Déplace ou redimensionne une fenêtre logée.
function placer(id, boite) {
  const info = logees.get(id);
  if (!info) return false;
  info.boite = boite;
  embed.configure(info.xid, versX11(boite));
  return true;
}

function remonter(id) {
  const info = logees.get(id);
  if (!info) return false;
  embed.stack(info.xid);
  return true;
}

/// Replie une fenêtre sans la fermer — l'équivalent d'une réduction.
function replier(id, replie) {
  const info = logees.get(id);
  if (!info) return false;
  if (replie) embed.unmap(info.xid);
  else { embed.map(info.xid); embed.stack(info.xid); }
  return true;
}

/// Oublie une fenêtre : sa session est finie, il n'y a rien à rendre.
function oublier(id) {
  logees.delete(id);
}

/// Rend une fenêtre au gestionnaire du système.
async function liberer(id) {
  const info = logees.get(id);
  if (!info) return false;
  logees.delete(id);
  await embed.release(info.xid).catch(() => {});
  return true;
}

const logee = (id) => logees.has(id);

/// Toutes les fenêtres logées quittent le bureau d'un coup.
///
/// Appelé quand le bureau se masque : une fenêtre reparentée dans une fenêtre
/// cachée disparaîtrait avec elle, sans moyen de la retrouver.
async function toutLiberer() {
  const ids = [...logees.keys()];
  for (const id of ids) await liberer(id);
  return ids.length;
}

module.exports = {
  TITRE,
  BARRE,
  ouvrir,
  fermer,
  ouvert,
  praticable,
  accueillir,
  placer,
  remonter,
  replier,
  oublier,
  liberer,
  logee,
  toutLiberer,
  envoyer,
  fenetre: () => bureau,
};
