'use strict';
// Processus principal : la fenêtre du lanceur, le raccourci global, l'icône de
// notification, et tout ce qui touche à l'appareil.
//
// Le rendu ne parle jamais à adb ni à scrcpy : il passe par les canaux déclarés
// ici, ce qui laisse le contexte d'isolation actif dans la fenêtre.

const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, Notification, nativeImage, screen, shell, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');

const device = require('./device');
const activity = require('./activity');
const layout = require('./layout');
const session = require('./session');
const { Store } = require('./store');
const { IconStore, openDexCacheDirs } = require('./icons');
const windows = require('./windows');
const install = require('./install');
const log = require('./log');
const update = require('./update');

let win = null;
let tray = null;
let store = null;
let icons = null;
let shownAt = 0;
let hotkeyState = null;

let current = { serial: null, info: null, engine: null, error: null };
const sessions = new Map();
let appsCache = { serial: null, apps: [], collectedAt: 0 };

const userData = () => app.getPath('userData');
const appsFile = (serial) => path.join(userData(), `apps-${serial || 'inconnu'}.json`);

const uiDir = () => path.join(__dirname, '..', 'ui');

/// Cette adresse désigne-t-elle un fichier de l'interface d'Aura ?
///
/// Comparaison après résolution, et non par préfixe de chaîne : `ui/../..` se
/// laisse écrire dans une URL, et un simple `startsWith` l'aurait accepté.
function dansLInterface(adresse) {
  try {
    const u = new URL(adresse);
    if (u.protocol !== 'file:') return false;
    // `fileURLToPath` plutôt que `pathname` : sous Windows, une adresse
    // `file:///C:/…` donne un chemin `/C:/…` que `path.resolve` ne comprend pas.
    const cible = path.resolve(url.fileURLToPath(u));
    const racine = path.resolve(uiDir());
    return cible === racine || cible.startsWith(racine + path.sep);
  } catch (_) {
    return false;
  }
}

// ── Fenêtre ─────────────────────────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    // Un widget, pas une fenêtre d'application : de quoi tenir les favoris et
    // une courte liste de résultats, rien de plus.
    width: 520,
    height: 240,
    minWidth: 340,
    minHeight: 150,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    alwaysOnTop: store.get('alwaysOnTop'),
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Le préchargement ne fait que déclarer des canaux : il n'a besoin ni de
      // `require`, ni du système de fichiers. Autant garder le bac à sable.
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  win.once('ready-to-show', () => {
    showLauncher();
    // Capture de contrôle, utile pour vérifier le rendu sans écran :
    //   AURA_SHOT=/tmp/aura.png npm start
    if (process.env.AURA_SHOT) {
      setTimeout(async () => {
        try {
          const image = await win.webContents.capturePage();
          fs.writeFileSync(process.env.AURA_SHOT, image.toPNG());
          console.log('capture écrite :', process.env.AURA_SHOT);
        } catch (err) {
          console.error('capture impossible :', err.message);
        }
      }, Number(process.env.AURA_SHOT_DELAY || 4000));
    }
  });

  // Un lanceur qui reste ouvert derrière les fenêtres n'a pas d'intérêt : il
  // s'efface dès qu'on le quitte, sauf s'il a été épinglé.
  //
  // Le délai de grâce n'est pas une précaution de style : sur X11, le
  // gestionnaire de fenêtres rend souvent le focus une fraction de seconde
  // après l'affichage, et sans lui le lanceur se refermerait aussitôt ouvert.
  win.on('blur', () => {
    if (Date.now() - shownAt < 600) return;
    if (!store.get('pinned') && !process.argv.includes('--dev')) win.hide();
  });

  // Le widget passe l'essentiel de son temps masqué, et la page doit le savoir
  // pour cesser de réveiller le téléphone. `document.hidden` ne suffit pas :
  // sous X11, `hide()` ne provoque pas toujours de `visibilitychange`, et la
  // page se croyait visible tout en étant invisible — les sondages tournaient
  // alors sans personne pour les lire.
  win.on('hide', () => {
    if (!win.isDestroyed()) win.webContents.send('launcher:hidden');
  });

  // Les liens externes ne doivent pas remplacer l'interface, et seuls le web
  // ordinaire y a droit : `file://`, `smb://` ou un schéma exotique confié au
  // système ouvrirait bien plus qu'une page.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // L'interface est un fichier local et le reste : rien ne doit pouvoir la
  // remplacer — ni par une page distante, ni par un autre fichier de la
  // machine. `file://` tout court laissait la seconde porte ouverte.
  win.webContents.on('will-navigate', (event, url) => {
    if (!dansLInterface(url)) event.preventDefault();
  });

  // Aucune permission web n'a de sens ici (caméra, micro, notifications…).
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
}

// Place le widget en haut, au centre de l'écran où se trouve le pointeur — là
// où l'œil le cherche, et hors du chemin des fenêtres d'application.
function placeTopCenter() {
  const cursor = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(cursor).workArea;
  const [width, height] = win.getSize();
  win.setPosition(
    Math.round(area.x + (area.width - width) / 2),
    Math.round(area.y + 24),
    false
  );
}

async function showLauncher() {
  if (!win) return;
  placeTopCenter();
  if (store.get('blurWallpaper')) {
    // Capture avant l'affichage : la fenêtre ne doit pas se photographier
    // elle-même.
    captureWallpaper().catch(() => {});
  }
  shownAt = Date.now();
  win.show();
  win.focus();
  // Certains gestionnaires de fenêtres X11 ignorent la première demande de
  // focus sur une fenêtre sans décor : on insiste une fois.
  setTimeout(() => { if (win && win.isVisible()) win.focus(); }, 120);
  win.webContents.send('launcher:shown');
}

function toggleLauncher() {
  if (!win) return;
  if (win.isVisible() && win.isFocused()) win.hide();
  else showLauncher();
}

// Le fond « flou du bureau » : Linux ne sait pas flouter ce qui se trouve
// derrière une fenêtre transparente (aucun compositeur ne l'expose de façon
// portable). On photographie donc l'écran avant d'afficher le lanceur, et le
// rendu s'en sert comme fond, décalé à la position de la fenêtre et flouté.
/// Délai en deçà duquel la dernière photographie fait encore l'affaire.
///
/// Le raccourci global se presse souvent deux fois de suite — on l'appelle, on
/// se ravise, on le rappelle. Photographier l'écran, l'encoder et faire passer
/// le résultat par l'IPC était jusqu'ici le poste le plus coûteux de
/// l'apparition du widget ; le refaire trois fois en deux secondes ne montre
/// rien de plus.
const FOND_FRAICHEUR = 2500;
let fondPris = 0;

async function captureWallpaper(force = false) {
  // Sous Wayland, chaque capture passe par le portail du bureau, qui demande à
  // l'utilisateur de désigner un écran. Le fond se prend à chaque apparition du
  // widget : ce serait une boîte de dialogue par appui sur le raccourci.
  const permis = session.wallpaperCapture();
  if (!permis.possible) return;
  if (!force && Date.now() - fondPris < FOND_FRAICHEUR) return;

  const bounds = win.getBounds();
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
  const scale = 0.35; // un fond flouté n'a pas besoin de définition

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * scale),
      height: Math.round(display.size.height * scale),
    },
  });
  if (!sources.length) return;

  const source =
    sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  fondPris = Date.now();
  win.webContents.send('wallpaper:frame', {
    // JPEG et non PNG : l'image part floutée derrière un verre dépoli, où la
    // compression avec perte ne se voit pas — et la chaîne base64 qui traverse
    // l'IPC passe de quelques centaines de kilo-octets à quelques dizaines.
    image: `data:image/jpeg;base64,${source.thumbnail.toJPEG(72).toString('base64')}`,
    display: display.bounds,
    scale,
  });
}

// ── Appareil ────────────────────────────────────────────────────────────────

async function connect() {
  current.error = null;
  try {
    current.engine = await device.findEngine();
  } catch (err) {
    current.engine = null;
    current.error = err.message;
    return current;
  }

  await device.startServer();
  const devices = await device.listDevices();
  const ready = devices.filter((d) => d.state === 'device');

  if (!ready.length) {
    const unauthorized = devices.find((d) => d.state === 'unauthorized');
    current.serial = null;
    current.info = null;
    current.error = unauthorized
      ? "l'appareil attend votre autorisation : déverrouillez-le et acceptez le débogage USB."
      : 'aucun appareil connecté. Branchez le téléphone et activez le débogage USB.';
    return current;
  }

  // Le dernier appareil choisi garde la main tant qu'il est là.
  const preferred = store.get('serial');
  const chosen = ready.find((d) => d.serial === preferred) || ready[0];
  const nouveau = current.serial !== chosen.serial;
  current.serial = chosen.serial;
  // `Store.set` ignore une écriture qui ne change rien : reposer le même numéro
  // de série à chaque reconnexion ne touche plus au fichier.
  store.set({ serial: chosen.serial });
  current.info = await deviceInfo(chosen.serial, nouveau);

  // Le magasin d'icônes ne se reconstruit que si l'appareil change : le
  // sondage régulier passe ici toutes les minutes, et réimporter cent
  // cinquante fichiers à chaque fois ne servirait à rien.
  if (!icons || icons.serial !== chosen.serial) {
    icons = new IconStore({
      adbPath: device.findAdb(),
      serial: chosen.serial,
      dir: path.join(userData(), 'icons'),
    });
    // OpenDex a peut-être déjà payé le prix de l'extraction : autant en profiter.
    icons.importFrom(openDexCacheDirs());
    loadApps(chosen.serial);
  }

  // Les guets tournent déjà pour cet appareil : les recréer à chaque
  // reconnexion — donc toutes les minutes — remettrait à zéro la cadence
  // adaptative du sondage d'appel.
  if (nouveau || !watchTimer) {
    homePkg = null;
    activity.homePackage(chosen.serial).then((pkg) => { homePkg = pkg; }).catch(() => {});
    startWatching();
    startCallWatch();
    startFollowWatch();
  }
  return current;
}

// ── Identité de l'appareil ──────────────────────────────────────────────────

/// Modèle, version d'Android et batterie.
///
/// Les deux premiers ne changent jamais pour un appareil donné ; seule la
/// batterie bouge, et `dumpsys battery` est de loin la plus coûteuse des trois
/// lectures. La reconnexion passe ici toutes les minutes : on garde le modèle en
/// mémoire et on n'interroge la batterie qu'à intervalle raisonnable.
const BATTERIE_FRAICHEUR = 120000;
let infoCache = { serial: null, info: null, at: 0 };

async function deviceInfo(serial, force = false) {
  const frais = infoCache.serial === serial && Date.now() - infoCache.at < BATTERIE_FRAICHEUR;
  if (!force && frais && infoCache.info) return infoCache.info;
  const info = await device.deviceInfo(serial);
  infoCache = { serial, info, at: Date.now() };
  return info;
}

function loadApps(serial) {
  try {
    const raw = JSON.parse(fs.readFileSync(appsFile(serial), 'utf8'));
    if (Array.isArray(raw.apps) && raw.apps.length) appsCache = raw;
  } catch (_) { /* pas encore d'inventaire */ }
}

async function refreshApps() {
  if (!current.serial) throw new Error('aucun appareil connecté');
  const apps = await device.listApps(current.serial);
  appsCache = { serial: current.serial, apps, collectedAt: Date.now() };
  try {
    fs.mkdirSync(userData(), { recursive: true });
    fs.writeFileSync(appsFile(current.serial), JSON.stringify(appsCache));
  } catch (_) { /* le cache n'est qu'un confort */ }
  return appsCache;
}

// ── Surveillance des notifications ──────────────────────────────────────────
//
// Le guet vit dans le processus principal, pas dans la page : le widget passe
// l'essentiel de son temps masqué, et une page masquée voit ses minuteries
// ralenties. C'est aussi ce qui permet d'être prévenu d'un appel sans avoir le
// widget sous les yeux.

const NOTIFICATION_POLL = 10000;
let watchTimer = null;
let knownKeys = new Set();
let primed = false;

function startWatching() {
  clearInterval(watchTimer);
  watchTimer = setInterval(() => { pollNotifications().catch(() => {}); }, NOTIFICATION_POLL);
}

async function pollNotifications() {
  if (!current.serial) return;

  // La liste des clés tient en deux cents octets ; le détail en pèse un million.
  const keys = await device.listNotificationKeys(current.serial);
  const seen = new Set(keys);
  const added = keys.filter((k) => !knownKeys.has(k));
  if (!added.length && seen.size === knownKeys.size) return;

  const list = await device.listNotifications(current.serial);
  knownKeys = seen;
  if (win && !win.isDestroyed()) win.webContents.send('notifications:changed', list);

  // Au premier passage, tout est « nouveau » : annoncer l'arriéré au démarrage
  // n'aurait aucun sens.
  if (!primed) { primed = true; return; }
  if (!store.get('desktopNotifications')) return;

  for (const item of list) {
    if (added.includes(item.key)) announce(item);
  }
}

/// Alerte du bureau pour une notification du téléphone.
function announce(item) {
  if (!Notification.isSupported()) return;

  const known = appsCache.apps.find((a) => a.package === item.package);
  const name = known ? known.name : item.package;
  const call = item.category === 'call';

  const notification = new Notification({
    title: call ? `Appel — ${item.title || name}` : item.title || name,
    body: [item.text, call ? null : name].filter(Boolean).join('\n'),
    urgency: call ? 'critical' : 'normal',
    icon: iconFile(item.package),
    silent: false,
  });

  // Cliquer sur l'alerte ouvre l'application concernée : c'est le geste
  // attendu, et le seul qu'ADB permette.
  notification.on('click', () => {
    launch(item.package).catch(() => {});
    showLauncher();
  });
  notification.show();

  // Un appel ne peut pas attendre le prochain coup d'œil au widget.
  if (call && store.get('raiseOnCall')) showLauncher();
}

/// Icône en cache utilisable par le système de notifications.
///
/// Le cache contient du PNG ou du WebP selon l'APK ; libnotify ne lit
/// pas toujours le second, alors on ne lui passe que ce qui est sûr.
function iconFile(pkg) {
  try {
    const file = path.join(userData(), 'icons', `${pkg}.img`);
    const head = Buffer.alloc(4);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    return head[0] === 0x89 && head[1] === 0x50 ? file : undefined;
  } catch (_) {
    return undefined;
  }
}

// ── Sessions ────────────────────────────────────────────────────────────────

/// Les options de pilotage des fenêtres, telles que les réglages les fixent.
const optionsFenetres = () => ({ xwayland: store.get('xwayland') !== false });

function sessionList() {
  return [...sessions.values()].map(({ child, log, ...rest }) => ({ ...rest, pid: child.pid }));
}

function broadcastSessions() {
  if (win && !win.isDestroyed()) win.webContents.send('sessions:changed', sessionList());
}

/// Taille d'ouverture d'une fenêtre d'application, pour cet écran-ci.
///
/// Le calcul lui-même vit dans `layout.js` : il est purement arithmétique, et
/// c'est justement ce qui le rend vérifiable sans écran ni téléphone. Ici on ne
/// fait que lui dire de quelle place on dispose.
function sizing(settings) {
  return layout.sizing(settings, screen.getPrimaryDisplay().workAreaSize);
}

/// Dernier échec de lancement, gardé pour l'écran de diagnostic.
let lastFailure = null;

function reportFailure(session) {
  const detail = (session.tail || []).join('\n');
  lastFailure = {
    package: session.package,
    name: session.name,
    at: Date.now(),
    error: session.error,
    hint: session.hint,
    reason: session.reason,
    command: (session.command || []).join(' '),
    tail: detail,
  };
  log.error(`échec du lancement de ${session.package} : ${session.error}`,
    [session.hint ? `cause probable : ${session.hint}` : null, (session.command || []).join(' '), detail]
      .filter(Boolean).join('\n'));
  if (win && !win.isDestroyed()) win.webContents.send('session:failed', lastFailure);
}

async function launch(pkg, once = null) {
  // Le nom de paquet vient de la page. Il ne traverse aucun shell — `spawn`
  // reçoit un tableau — mais il devient `--start-app=…` et n'a donc aucune
  // raison de ressembler à autre chose qu'un nom de paquet.
  device.assertPackage(pkg);
  const app_ = appsCache.apps.find((a) => a.package === pkg) || { package: pkg, name: pkg };
  // Trois couches, de la plus générale à la plus précise : réglages communs,
  // réglages mémorisés pour cette application, puis le choix d'un seul
  // lancement.
  const settings = { ...store.all, ...store.overrideFor(pkg), ...(once || {}) };
  Object.assign(settings, sizing(settings));
  // Certaines surcouches font transiter l'application par l'écran principal
  // avant de la poser sur l'écran virtuel. Le guet des applications liées doit
  // laisser passer ce battement, sans quoi il proposerait d'ouvrir ce qui est en
  // train de s'ouvrir.
  followRepit = Date.now() + 8000;

  let session;
  try {
    session = await device.launchApp(current.serial, app_, settings, {
      onUpdate: (s) => {
        if (s.state === 'stopped' || s.state === 'failed') sessions.delete(s.id);
        broadcastSessions();
      },
      onFail: (s) => {
        sessions.delete(s.id);
        broadcastSessions();
        reportFailure(s);
      },
      // Le balayage des serveurs orphelins n'est pas sélectif : il n'a lieu que
      // si cet échec est le seul en piste (voir `device.purgeStaleServer`).
      canPurge: () => sessions.size === 0,
    });
  } catch (err) {
    // Échec avant même d'avoir un processus : moteur absent, binaire
    // illisible… Cela remonte au rendu par le rejet, mais le journal doit
    // en garder trace.
    log.error(`lancement impossible pour ${pkg} : ${err.message}`);
    throw err;
  }
  sessions.set(session.id, session);
  store.remember(pkg);
  broadcastSessions();
  log.info(`lancement de ${pkg}`, (session.command || []).join(' '));

  if (store.get('hideAfterLaunch') && win) win.hide();
  return { id: session.id, package: pkg };
}

function closeSession(id) {
  const session = sessions.get(id);
  if (!session) return false;
  // SIGTERM laisse scrcpy fermer proprement l'écran virtuel ; le tuer sec
  // laisserait parfois l'écran ouvert sur l'appareil.
  try { session.child.kill('SIGTERM'); } catch (_) {}
  sessions.delete(id);
  broadcastSessions();
  return true;
}

// ── Applications liées ──────────────────────────────────────────────────────
//
// Un geste dans une fenêtre Aura mène souvent ailleurs : le composeur propose
// d'envoyer un message, un appel demande par quelle carte SIM partir. Android
// pose alors la suite sur l'écran **principal** du téléphone — hors de vue — et
// aucune commande ne permet de la déplacer (voir `activity.js`).
//
// Ce guet regarde donc ce qui surgit là-bas, et y répond : le miroir pour ce qui
// attend une validation, une vraie fenêtre Aura pour ce qui est une application.

/// Cadence du guet. Il ne tourne que lorsqu'une fenêtre est ouverte : sans
/// session, ce qui se passe sur le téléphone ne regarde pas Aura.
const FOLLOW_POLL = 3000;

/// Délai pendant lequel un paquet déjà signalé ne l'est plus. Une application
/// qu'on vient d'écarter ne doit pas revenir frapper trois secondes plus tard.
const FOLLOW_REPOS = 45000;

let followTimer = null;
let followDevant = null;
let homePkg = null;
/// Jusqu'à quand ignorer ce qui passe devant. Nos propres lancements font
/// transiter l'application par l'écran principal sur certaines surcouches : sans
/// ce répit, Aura se proposerait d'ouvrir ce qu'elle vient d'ouvrir.
let followRepit = 0;
const followVus = new Map();

function startFollowWatch() {
  clearInterval(followTimer);
  followTimer = setInterval(() => { pollForeground().catch(() => {}); }, FOLLOW_POLL);
}

/// Les paquets qui ont déjà leur fenêtre Aura.
function paquetsOuverts() {
  return new Set([...sessions.values()].map((s) => s.package).filter(Boolean));
}

async function pollForeground() {
  if (!current.serial) return;

  // Aucune fenêtre ouverte : rien de ce qui arrive sur le téléphone ne découle
  // d'Aura, et le guet se rendort — état remis à zéro pour que la première
  // observation de la prochaine session serve de référence, non d'événement.
  const vivantes = [...sessions.values()].filter((s) => !s.mirror);
  if (!vivantes.length) { followDevant = null; return; }
  if (store.get('followLaunches') === 'off' && !store.get('mirrorOnDialog')) return;

  const ecrans = await activity.foreground(current.serial);
  if (!ecrans) return;

  const devant = ecrans[activity.ECRAN_PRINCIPAL];
  const signature = devant ? `${devant.package}/${devant.activity}` : '';
  if (signature === followDevant) return;

  // La première lecture d'une session établit le point de départ. Réagir
  // dessus ferait surgir une fenêtre pour l'écran d'accueil au premier
  // lancement.
  const amorce = followDevant === null;
  followDevant = signature;
  if (amorce || !devant) return;
  if (Date.now() < followRepit) return;
  if (homePkg && devant.package === homePkg) return;

  // Une boîte du système attend une réponse, et elle ne s'affichera nulle part
  // ailleurs que sur la dalle du téléphone : le miroir est la seule façon de la
  // voir — et donc d'y répondre — depuis l'ordinateur.
  if (activity.estBoite(devant)) {
    log.info(`validation attendue sur le téléphone : ${devant.package}/${devant.activity}`);
    if (store.get('mirrorOnDialog')) {
      openMirror().catch(() => {});
      raconteSuivi({ type: 'dialogue', package: devant.package });
    }
    return;
  }

  if (store.get('followLaunches') === 'off') return;
  // Déjà dans sa propre fenêtre : c'est l'écran principal qui la reflète, pas
  // une application à ouvrir.
  if (paquetsOuverts().has(devant.package)) return;

  const vu = followVus.get(devant.package);
  if (vu && Date.now() - vu < FOLLOW_REPOS) return;
  followVus.set(devant.package, Date.now());

  const connu = appsCache.apps.find((a) => a.package === devant.package);
  const nom = connu ? connu.name : devant.package;

  if (store.get('followLaunches') === 'auto') {
    log.info(`application liée ouverte d'office : ${devant.package}`);
    try {
      await launch(devant.package);
      raconteSuivi({ type: 'ouverte', package: devant.package, nom });
    } catch (err) {
      log.warn(`ouverture de ${devant.package} impossible : ${err.message}`);
    }
    return;
  }

  log.info(`application liée proposée : ${devant.package}`);
  proposeSuivi(devant.package, nom);
}

function raconteSuivi(message) {
  if (win && !win.isDestroyed()) win.webContents.send('follow', message);
}

/// Propose d'ouvrir une application liée, là où l'utilisateur regarde.
///
/// Et c'est rarement le widget : au moment où le composeur renvoie vers les
/// messages, ce qu'il a sous les yeux est la fenêtre du composeur. Une alerte
/// dans le widget masqué ne serait jamais vue, d'où l'alerte du bureau — qui
/// porte la même action.
function proposeSuivi(pkg, nom) {
  const visible = win && !win.isDestroyed() && win.isVisible();
  if (visible) return raconteSuivi({ type: 'proposée', package: pkg, nom });
  if (!Notification.isSupported()) return;

  const n = new Notification({
    title: `${nom} s'est ouverte sur le téléphone`,
    body: 'Cliquez pour lui donner sa propre fenêtre.',
    icon: iconFile(pkg),
  });
  n.on('click', () => {
    followRepit = Date.now() + 8000;
    launch(pkg).catch((err) => log.warn(`ouverture de ${pkg} impossible : ${err.message}`));
  });
  n.show();
}

// ── Miroir du téléphone ─────────────────────────────────────────────────────

let mirrorId = null;

/// Ouvre — ou ramène — la fenêtre qui recopie l'écran du téléphone.
///
/// Une seule à la fois : deux miroirs du même écran n'apportent rien et
/// doublent le coût d'encodage.
async function openMirror() {
  if (mirrorId && sessions.has(mirrorId)) {
    const existante = sessions.get(mirrorId);
    const bougé = await windows.toggle(existante.child.pid, optionsFenetres());
    // Si la fenêtre était déjà devant, `toggle` l'aurait réduite : ce n'est
    // pas ce qu'on veut quand on demande explicitement le miroir.
    if (bougé.action === 'minimized') await windows.toggle(existante.child.pid, optionsFenetres());
    return { id: mirrorId, mirror: true };
  }

  const settings = { ...store.all };
  Object.assign(settings, sizing({ ...settings, flex: false }));
  const session = await device.mirror(current.serial, settings, {
    onUpdate: (s) => {
      if (s.state === 'stopped' || s.state === 'failed') {
        sessions.delete(s.id);
        if (mirrorId === s.id) mirrorId = null;
      }
      broadcastSessions();
    },
    onFail: (s) => {
      sessions.delete(s.id);
      if (mirrorId === s.id) mirrorId = null;
      broadcastSessions();
      reportFailure(s);
    },
    canPurge: () => sessions.size === 0,
  });
  session.mirror = true;
  sessions.set(session.id, session);
  mirrorId = session.id;
  broadcastSessions();
  log.info('miroir de l\'écran principal', (session.command || []).join(' '));
  return { id: session.id, mirror: true };
}

// ── Appels ──────────────────────────────────────────────────────────────────
//
// L'écran d'appel entrant s'affiche sur l'écran **principal** du téléphone —
// jamais sur un écran virtuel. Sans miroir, on ne le verrait pas ; sans
// surveillance, on ne saurait même pas qu'il sonne.

// Sondage adaptatif : 3 s tant que la fenêtre est visible ou qu'un appel est
// en cours (il faut voir sonner sans délai), 9 s sinon — la fenêtre masquée ne
// mobilise pas adb et dumpsys pour rien, tout en restant réactive.
const CALL_POLL = 3000;
const CALL_POLL_HIDDEN = 9000;
let callTimer = null;
let callNow = null;

function startCallWatch() {
  clearInterval(callTimer);
  let elapsed = 0;
  callTimer = setInterval(() => {
    elapsed += CALL_POLL;
    const visible = win && !win.isDestroyed() && win.isVisible();
    if (!visible && !callNow && elapsed < CALL_POLL_HIDDEN) return;
    elapsed = 0;
    pollCall().catch(() => {});
  }, CALL_POLL);
}

async function pollCall() {
  if (!current.serial) return;
  const appel = await device.callState(current.serial);
  const avant = callNow ? `${callNow.id}:${callNow.state}` : '';
  const apres = appel ? `${appel.id}:${appel.state}` : '';
  if (avant === apres) return;

  const nouveau = appel && (!callNow || callNow.id !== appel.id);
  callNow = appel;
  if (win && !win.isDestroyed()) win.webContents.send('call:changed', appel);
  if (!appel) return;

  log.info(`appel ${appel.state} (${appel.id})`);

  // Un appel entrant ne peut pas attendre le prochain coup d'œil au widget.
  if (nouveau && appel.state === 'RINGING' && store.get('raiseOnCall')) {
    showLauncher();
    if (store.get('mirrorOnCall')) openMirror().catch(() => {});
  }
}

// ── Mise à jour ─────────────────────────────────────────────────────────────

const UPDATE_DELAY = 20000;

/// Branche le vérificateur, et regarde une fois passé le démarrage.
///
/// Pas au premier instant : les vingt premières secondes appartiennent à
/// l'inventaire des applications et à l'extraction des icônes, qui se
/// partagent déjà le même câble USB et la même patience.
function startUpdates() {
  // En développement, `electron-updater` n'a pas de paquet auquel se comparer
  // et lève une erreur à chaque appel. On ne le sollicite donc que là où il a
  // un sens : dans une application installée.
  if (!app.isPackaged) return;

  update.init((etat) => {
    if (win && !win.isDestroyed()) win.webContents.send('update:changed', etat);
    if (etat.statut === 'disponible' && store.get('autoUpdate')) update.download();
    if (etat.statut === 'prête') announceUpdate(etat);
  });

  if (store.get('autoUpdate')) setTimeout(() => { update.check(); }, UPDATE_DELAY);
}

/// Une version prête ne s'impose pas : elle se propose.
function announceUpdate(etat) {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: `Aura ${etat.version} est prête`,
    body: "Cliquez pour redémarrer et l'installer.",
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
  });
  n.on('click', () => update.install());
  n.show();
}

// ── Diagnostic ──────────────────────────────────────────────────────────────

async function gatherDiagnostic() {
  const report = await device.diagnostics(current.serial);
  report.aura = app.getVersion();
  report.tools = await windows.tools(optionsFenetres());
  report.session = session.sessionType();
  report.log = log.chemin();
  report.lastFailure = lastFailure;
  return report;
}

/// Le rapport en texte brut. Assemblé ici plutôt que dans la page : deux
/// fenêtres le demandent, et il ne doit exister qu'une seule version.
function formatDiagnostic(d) {
  const lignes = [
    `Aura ${d.aura} — ${d.platform}${d.appimage ? ' (AppImage)' : ''}`,
    `Session : ${d.session} — bureau ${d.desktop} — affichage ${d.display}`,
    `Moteur : ${d.engine || `INTROUVABLE — ${d.engineError}`}`,
    `adb : ${d.adb}`,
    `Appareil : ${d.device || 'aucun'}`,
  ];
  if (d.deviceWarning) lignes.push(`⚠ ${d.deviceWarning}`);

  const outils = d.tools || {};
  lignes.push(
    outils.raison
      ? `Fenêtres : ${outils.raison}`
      : `Fenêtres : ${outils.via === 'xwayland' ? 'via XWayland — ' : ''}` +
        `wmctrl ${outils.wmctrl ? 'oui' : 'non'}, xdotool ${outils.xdotool ? 'oui' : 'non'}, python3-xlib ${outils.xlib ? 'oui' : 'non'}`
  );
  lignes.push(`Journal : ${d.log || 'désactivé'}`);

  const f = d.lastFailure;
  if (f) {
    lignes.push('', `Dernier échec — ${f.name} (${f.package})`, f.error);
    if (f.reason) lignes.push(`Message de scrcpy : ${f.reason}`);
    if (f.hint) lignes.push(`Cause probable : ${f.hint}`);
    if (f.command) lignes.push(`Commande : ${f.command}`);
    if (f.tail) lignes.push('Sortie de scrcpy :', f.tail);
  } else {
    lignes.push('', 'Aucun échec de lancement enregistré depuis le démarrage.');
  }
  return lignes.join('\n');
}

let diagWin = null;

/// Le diagnostic mérite une vraie fenêtre.
///
/// Le widget fait 520 px de large et ajuste sa hauteur à son contenu : un
/// rapport de trente lignes n'y est pas lisible, et on ne peut pas
/// l'agrandir. Ici, cadre normal, taille libre, texte sélectionnable.
function openDiagnostic() {
  if (diagWin && !diagWin.isDestroyed()) {
    diagWin.show();
    diagWin.focus();
    return diagWin;
  }

  diagWin = new BrowserWindow({
    width: 760,
    height: 620,
    minWidth: 420,
    minHeight: 320,
    title: 'Aura — diagnostic',
    backgroundColor: '#0d0f16',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      // Son propre pont, réduit aux quatre canaux du diagnostic : cette fenêtre
      // n'a pas à pouvoir envoyer des fichiers ni lancer des applications.
      preload: path.join(__dirname, 'preload-diag.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  diagWin.loadFile(path.join(uiDir(), 'diagnostic.html'));
  diagWin.on('closed', () => { diagWin = null; });
  return diagWin;
}

// ── Canaux ──────────────────────────────────────────────────────────────────

function registerIpc() {
  ipcMain.handle('bootstrap', async () => {
    const state = await connect();
    return {
      settings: store.all,
      version: app.getVersion(),
      hotkeyResult: hotkeyState,
      engine: state.engine ? { path: state.engine.path, version: state.engine.version.release } : null,
      device: state.info,
      error: state.error,
      apps: appsCache.apps,
      collectedAt: appsCache.collectedAt,
      sessions: sessionList(),
    };
  });

  ipcMain.handle('device:refresh', async () => {
    const state = await connect();
    return { device: state.info, error: state.error, apps: appsCache.apps, collectedAt: appsCache.collectedAt };
  });

  /// Les appareils prêts, pour le sélecteur de la barre. Deux téléphones
  /// branchés ne doivent jamais en faire disparaître un.
  ipcMain.handle('devices:list', async () => {
    await device.startServer();
    const devices = await device.listDevices();
    return Promise.all(
      devices
        .filter((d) => d.state === 'device')
        .map(async (d) => ({
          serial: d.serial,
          current: d.serial === current.serial,
          model: (await device.deviceInfo(d.serial).catch(() => null))?.model || d.serial,
        }))
    );
  });

  /// Change d'appareil : le choix est mémorisé (connect() le reprendra), les
  /// états de sondage sont remis à zéro pour ne pas mélanger deux téléphones.
  ipcMain.handle('device:select', async (_e, serial) => {
    await device.startServer();
    const devices = await device.listDevices();
    if (!devices.some((d) => d.serial === serial && d.state === 'device')) {
      throw new Error('appareil introuvable ou non autorisé');
    }
    store.set({ serial });
    knownKeys = new Set();
    callNow = null;
    const state = await connect();
    return { device: state.info, error: state.error, apps: appsCache.apps, collectedAt: appsCache.collectedAt };
  });

  // État radio du téléphone. Rien de bloquant : si la lecture échoue, l'interface
  // affiche simplement les icônes au repos.
  ipcMain.handle('device:connectivity', async () => {
    if (!current.serial) return null;
    return device.connectivity(current.serial).catch(() => null);
  });

  /// Tout ce que le centre de contrôle affiche, en un seul aller-retour USB :
  /// radios, volume média, mode de sonnerie, Ne pas déranger.
  ipcMain.handle('device:quickstate', async () => {
    if (!current.serial) return null;
    const [net, vol, ringer, dnd] = await Promise.all([
      device.connectivity(current.serial).catch(() => null),
      device.mediaVolume(current.serial).catch(() => null),
      device.ringerMode(current.serial).catch(() => null),
      device.dndState(current.serial).catch(() => null),
    ]);
    return { net, volume: vol, ringer, dnd };
  });

  const avecAppareil = (fn) => async (_e, ...args) => {
    if (!current.serial) throw new Error('aucun appareil connecté');
    return fn(current.serial, ...args);
  };

  // ── Pont bureau → téléphone ───────────────────────────────────────────────
  //
  // Un envoi peut durer des minutes : la poignée rend la main tout de suite et
  // la suite du récit passe par des évènements, sinon l'interface reste figée
  // sur une promesse et l'utilisateur ne sait rien de ce qui se passe.
  let prochainTransfert = 1;

  const raconte = (message) => {
    if (win && !win.isDestroyed()) win.webContents.send('transfer', message);
  };

  /// Un chemin envoyable : absolu, existant, et un fichier ordinaire.
  ///
  /// Le préchargement ne laisse déjà passer que des chemins issus d'un vrai
  /// dépôt (voir `preload.js`). Ce second filtre ne répète pas le premier : il
  /// écarte ce qu'un dépôt peut légitimement contenir sans qu'on sache
  /// l'envoyer — un dossier, un tube nommé, un lien mort.
  const envoyable = (chemin) => {
    if (typeof chemin !== 'string' || !path.isAbsolute(chemin)) return false;
    try {
      return fs.statSync(chemin).isFile();
    } catch (_) {
      return false;
    }
  };

  ipcMain.handle('bridge:send', async (_e, demandes) => {
    if (!current.serial) throw new Error('aucun appareil connecté');
    const liste = (Array.isArray(demandes) ? demandes : []).filter((d) => d && envoyable(d.path));
    if (!liste.length) throw new Error('rien à envoyer');

    for (const demande of liste) {
      const id = prochainTransfert++;
      const nom = path.basename(demande.path);
      const install = demande.action === 'install';
      raconte({ id, nom, état: 'en cours', install, envoyé: 0, total: null });
      try {
        if (install) {
          await device.installApk(current.serial, demande.path);
          raconte({ id, nom, état: 'fini', install, message: 'Application installée' });
          log.info(`installation de ${nom}`);
        } else {
          const r = await device.pushFile(current.serial, demande.path, {
            onProgress: ({ sent, total }) => raconte({ id, nom, état: 'en cours', install, envoyé: sent, total }),
          });
          raconte({ id, nom, état: 'fini', install, message: 'Reçu dans Téléchargements', bytes: r.bytes });
          log.info(`envoi de ${nom} (${r.bytes} octets)`);
        }
      } catch (err) {
        raconte({ id, nom, état: 'échec', install, message: err.message });
        log.warn(`échec de l'envoi de ${nom} : ${err.message}`);
      }
    }
    return { count: liste.length };
  });

  ipcMain.handle('bridge:url', avecAppareil((serial, url) => device.openUrl(serial, url)));

  /// Tout le panneau Wi-Fi en un aller-retour : état, réseaux en portée,
  /// réseaux enregistrés. Le scan dure quelques secondes, d'où le délai large
  /// laissé au rendu côté interface.
  ipcMain.handle('wifi:list', avecAppareil(async (serial, rescan = true) => {
    const [status, scan, saved] = await Promise.all([
      device.wifiStatus(serial).catch(() => null),
      device.wifiScan(serial, { rescan }).catch(() => []),
      device.wifiSaved(serial).catch(() => []),
    ]);
    return { status, scan, saved };
  }));

  // Le mot de passe s'arrête ici : aucune de ces poignées ne journalise ses
  // arguments, et `device.wifiSuggest` ne les écrit nulle part non plus.
  ipcMain.handle('wifi:join', avecAppareil((serial, demande) => device.wifiSuggest(serial, demande || {})));
  ipcMain.handle('wifi:forget', avecAppareil((serial, id) => device.wifiForget(serial, id)));
  ipcMain.handle('wifi:unsuggest', avecAppareil((serial, ssid) => device.wifiUnsuggest(serial, ssid)));
  ipcMain.handle('wifi:suggestions', avecAppareil((serial) => device.wifiSuggestions(serial)));
  ipcMain.handle('wifi:settings', avecAppareil((serial) => device.openWifiSettings(serial)));

  ipcMain.handle('quick:volume', avecAppareil((serial, delta) => device.changeMediaVolume(serial, delta)));
  ipcMain.handle('quick:ringer', avecAppareil((serial, mode) => device.setRingerMode(serial, mode)));
  ipcMain.handle('quick:dnd', avecAppareil((serial, on) => device.setDnd(serial, on)));
  ipcMain.handle('quick:radio', avecAppareil((serial, radio, on) => device.setRadio(serial, radio, on)));

  ipcMain.handle('apps:refresh', async () => {
    const fresh = await refreshApps();
    return { apps: fresh.apps, collectedAt: fresh.collectedAt };
  });

  ipcMain.handle('icon:get', async (_e, pkg) => {
    if (!icons) return null;
    return icons.icon(pkg);
  });

  ipcMain.handle('icons:clear', async () => {
    if (icons) icons.clear();
    return true;
  });

  ipcMain.handle('app:launch', async (_e, pkg, once) => launch(pkg, once));

  ipcMain.handle('mirror:open', async () => openMirror());

  /// La page accepte l'application liée qu'on lui a proposée.
  ///
  /// Le paquet ne fait pas confiance à la page pour autant : `launch` le
  /// contrôle, et le geste serait de toute façon possible par la recherche.
  ipcMain.handle('follow:accept', async (_e, pkg) => {
    followRepit = Date.now() + 8000;
    return launch(pkg);
  });

  ipcMain.handle('update:state', async () => ({ ...update.state(), packaged: app.isPackaged, version: app.getVersion() }));
  ipcMain.handle('update:check', async () => {
    if (!app.isPackaged) return { statut: 'développement', packaged: false };
    return update.check();
  });
  ipcMain.handle('update:download', async () => update.download());
  ipcMain.handle('update:install', async () => { update.install(); return true; });

  ipcMain.handle('call:state', async () => callNow);

  ipcMain.handle('call:answer', async () => {
    const ok = await device.answerCall(current.serial);
    log.info(`décrocher : ${ok ? 'envoyé' : 'refusé'}`);
    return ok;
  });

  ipcMain.handle('call:hangup', async () => {
    const ok = await device.hangUpCall(current.serial);
    log.info(`raccrocher : ${ok ? 'envoyé' : 'refusé'}`);
    return ok;
  });

  ipcMain.handle('call:dial', async (_e, number) => {
    // Le composeur s'ouvre dans une fenêtre Aura, pas sur le téléphone : on
    // lui donne d'abord un écran virtuel à lui.
    const dialer = (await device.defaultDialer(current.serial)) || store.get('dialer');
    const session = await launch(dialer);
    const cible = sessions.get(session.id);
    for (let i = 0; i < 40 && cible && cible.displayId === null; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
    }
    return device.dial(current.serial, number, cible ? cible.displayId : null);
  });

  ipcMain.handle('diag:text', async () => formatDiagnostic(await gatherDiagnostic()));

  ipcMain.handle('diag:window', async () => { openDiagnostic(); return true; });

  ipcMain.handle('diag:get', async () => gatherDiagnostic());

  ipcMain.handle('diag:log', async () => log.tail(300));

  ipcMain.handle('diag:open', async () => {
    const file = log.chemin();
    if (!file) return false;
    shell.showItemInFolder(file);
    return true;
  });
  ipcMain.handle('overrides:get', async (_e, pkg) => store.overrideFor(pkg));
  ipcMain.handle('overrides:set', async (_e, pkg, patch) => store.setOverride(pkg, patch));
  ipcMain.handle('session:close', async (_e, id) => closeSession(id));
  ipcMain.handle('sessions:list', async () => sessionList());

  // Cliquer sur une fenêtre ouverte la ramène — ou la réduit si elle est déjà
  // au premier plan.
  ipcMain.handle('session:toggle', async (_e, id) => {
    const session = sessions.get(id);
    if (!session) return { action: 'none', reason: 'session terminée' };
    return windows.toggle(session.child.pid, optionsFenetres());
  });

  // Installation du moteur vidéo, avec l'avancement renvoyé au fil de l'eau.
  ipcMain.handle('engine:install', async () => {
    const engine = await install.install((progress) => {
      if (win && !win.isDestroyed()) win.webContents.send('engine:progress', progress);
    });
    // Le moteur trouvé est mis en cache : après installation, il faut le
    // rechercher à nouveau, sinon l'ancienne absence resterait vraie.
    device.resetEngine();
    await connect();
    return { path: engine, version: install.RELEASE.version };
  });

  ipcMain.handle('engine:target', async () => ({
    target: install.target(),
    version: install.RELEASE.version,
    megabytes: Math.round((install.RELEASE.archives[install.target()] || {}).bytes / 1024 / 1024) || null,
  }));

  ipcMain.handle('notifications:keys', async () => {
    if (!current.serial) return [];
    return device.listNotificationKeys(current.serial);
  });

  ipcMain.handle('notifications:list', async () => {
    if (!current.serial) return [];
    return device.listNotifications(current.serial);
  });

  ipcMain.handle('notifications:dismiss', async (_e, key) => {
    if (!current.serial) return false;
    return device.dismissNotification(current.serial, key);
  });

  ipcMain.handle('notifications:dismiss-all', async (_e, keys) => {
    if (!current.serial) return 0;
    return device.dismissAll(current.serial, keys);
  });

  ipcMain.handle('notifications:shade', async () => {
    if (current.serial) await device.expandNotificationShade(current.serial);
    return true;
  });

  ipcMain.handle('settings:set', async (_e, patch) => {
    const settings = store.set(patch);
    if ('alwaysOnTop' in patch && win) win.setAlwaysOnTop(!!settings.alwaysOnTop);
    // Le protocole change ce que `wmctrl` peut voir : le verdict mis en cache
    // n'est plus valable.
    if ('xwayland' in patch) windows.reset();
    if ('hotkey' in patch) {
      const result = registerHotkey();
      return { ...store.all, hotkeyResult: result };
    }
    return settings;
  });

  ipcMain.handle('favorites:toggle', async (_e, pkg) => store.toggleFavorite(pkg));
  ipcMain.handle('favorites:reorder', async (_e, order) => store.reorderFavorites(order));

  // La fenêtre épouse la hauteur de son contenu, entre deux bornes : sous 180
  // px l'interface se replie, au-delà de 560 elle cesse d'être un widget.
  ipcMain.handle('window:fit', async (_e, height) => {
    if (!win || store.get('freeHeight')) return;
    const [width] = win.getSize();
    // Le contenu suit désormais l'échelle de la fenêtre : à 340 px de large il
    // tient en très peu de haut, à 700 px il en demande davantage. La borne
    // basse suit donc la largeur plutôt que d'être fixe.
    const wanted = Math.max(140, Math.min(620, Math.round(height)));
    if (Math.abs(win.getSize()[1] - wanted) > 6) win.setSize(width, wanted, false);
  });

  ipcMain.handle('window:hide', async () => { if (win) win.hide(); });
  ipcMain.handle('window:quit', async () => { app.quit(); });
  // Demandé explicitement par la page : elle a une raison de vouloir du neuf.
  ipcMain.handle('wallpaper:refresh', async () => { await captureWallpaper(true); });
}

// ── Raccourci global et icône de barre ──────────────────────────────────────

// Modificateurs qu'Electron sait enregistrer comme raccourci global.
//
// `AltGr` figure dans la documentation mais n'est pas utilisable ici : sous X11
// c'est `ISO_Level3_Shift`, une touche de composition, et `register` ne refuse
// pas la combinaison — il abat le processus sur un `Check failed: false`. On
// filtre donc en amont, car un crash de ce genre n'est pas rattrapable.
const MODIFIERS = new Set([
  'command', 'cmd', 'control', 'ctrl', 'commandorcontrol', 'cmdorctrl',
  'alt', 'option', 'shift', 'super', 'meta',
]);

const KEY =
  /^(?:[a-z0-9]|f(?:[1-9]|1[0-9]|2[0-4])|space|tab|backspace|delete|insert|return|enter|escape|esc|up|down|left|right|home|end|pageup|pagedown|plus|minus|capslock|numlock|printscreen|,|\.|\/|\\|;|'|\[|\]|`|=|-)$/i;

/// Une combinaison utilisable : au moins un modificateur, puis une touche connue.
function isSafeAccelerator(accelerator) {
  if (typeof accelerator !== 'string') return false;
  const parts = accelerator.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  const key = parts.pop();
  return parts.every((p) => MODIFIERS.has(p.toLowerCase())) && KEY.test(key);
}

// Combinaisons de repli, dans l'ordre de préférence. Toutes sont peu prises :
// Ctrl+Espace appartient aux méthodes de saisie, Alt+Espace au menu de fenêtre.
const FALLBACKS = ['Ctrl+Alt+Space', 'Super+A', 'Ctrl+Alt+A', 'Ctrl+Shift+Space', 'Ctrl+Alt+K'];

/// Enregistre le premier raccourci qui tienne, et retourne ce qui a été retenu.
///
/// Le raccourci demandé peut être refusé de deux façons : la combinaison est
/// inutilisable (filtrée ici), ou une autre application l'a déjà prise
/// (`register` retourne alors `false`). Dans les deux cas on ne laisse pas
/// l'utilisateur sans raccourci : on descend la liste de repli.
function registerHotkey() {
  globalShortcut.unregisterAll();

  const wanted = store.get('hotkey');
  const candidates = [wanted, ...FALLBACKS].filter(Boolean);
  const rejected = [];

  for (const candidate of candidates) {
    if (!isSafeAccelerator(candidate)) {
      rejected.push(candidate);
      continue;
    }
    let ok = false;
    try {
      ok = globalShortcut.register(candidate, toggleLauncher);
    } catch (_) {
      ok = false;
    }
    if (ok) {
      if (candidate !== wanted) store.set({ hotkey: candidate });
      return { hotkey: candidate, requested: wanted, refused: candidate !== wanted };
    }
    rejected.push(candidate);
  }

  return { hotkey: null, requested: wanted, refused: true, rejected };
}

function createTray() {
  const image = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png'));
  tray = new Tray(image.resize({ width: 22, height: 22 }));
  tray.setToolTip('Aura — vos applications Android');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Ouvrir le lanceur', click: showLauncher },
      { type: 'separator' },
      { label: 'Actualiser les applications', click: () => refreshApps().catch(() => {}) },
      { type: 'separator' },
      { label: 'Quitter', click: () => app.quit() },
    ])
  );
  tray.on('click', toggleLauncher);
}

// ── Cycle de vie ────────────────────────────────────────────────────────────

const single = app.requestSingleInstanceLock();
if (!single) {
  app.quit();
} else {
  app.on('second-instance', showLauncher);

  app.whenReady().then(() => {
    store = new Store(path.join(userData(), 'config.json'));
    log.init(userData());
    registerIpc();
    createWindow();
    createTray();
    hotkeyState = registerHotkey();
    startUpdates();
  });

  app.on('window-all-closed', () => { /* le lanceur vit dans la barre système */ });

  app.on('will-quit', () => {
    clearInterval(watchTimer);
    clearInterval(callTimer);
    clearInterval(followTimer);
    device.closeShell();
    globalShortcut.unregisterAll();
    // Laisser des scrcpy orphelins laisserait aussi des écrans virtuels ouverts
    // sur le téléphone.
    for (const session of sessions.values()) {
      try { session.child.kill('SIGTERM'); } catch (_) {}
    }
  });
}
