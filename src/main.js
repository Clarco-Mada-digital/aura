'use strict';
// Processus principal : la fenêtre du lanceur, le raccourci global, l'icône de
// notification, et tout ce qui touche à l'appareil.
//
// Le rendu ne parle jamais à adb ni à scrcpy : il passe par les canaux déclarés
// ici, ce qui laisse le contexte d'isolation actif dans la fenêtre.

const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, Notification, nativeImage, screen, shell, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');

const device = require('./device');
const { Store } = require('./store');
const { IconStore, openDexCacheDirs } = require('./icons');
const windows = require('./windows');
const install = require('./install');
const log = require('./log');

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

  // Les liens externes ne doivent pas remplacer l'interface, et seuls le web
  // ordinaire y a droit : `file://`, `smb://` ou un schéma exotique confié au
  // système ouvrirait bien plus qu'une page.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // L'interface est un fichier local et le reste : rien ne doit pouvoir la
  // remplacer par une page distante.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
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
async function captureWallpaper() {
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
  win.webContents.send('wallpaper:frame', {
    image: source.thumbnail.toDataURL(),
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
  current.serial = chosen.serial;
  store.set({ serial: chosen.serial });
  current.info = await device.deviceInfo(chosen.serial);

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

  startWatching();
  return current;
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

function sessionList() {
  return [...sessions.values()].map(({ child, log, ...rest }) => ({ ...rest, pid: child.pid }));
}

function broadcastSessions() {
  if (win && !win.isDestroyed()) win.webContents.send('sessions:changed', sessionList());
}

/// Ramène la fenêtre d'application à une fraction de l'écran, par le chemin
/// que scrcpy autorise.
///
/// Il y a deux façons de faire une petite fenêtre, et elles ne donnent pas du
/// tout le même résultat :
///
///   - **Réduire l'image.** L'écran virtuel garde sa définition et sa densité,
///     et scrcpy met la vidéo à l'échelle. La mise en page Android est
///     exactement celle du téléphone, en plus petit. C'est ce qu'on veut, et
///     c'est le plus net.
///   - **Réduire l'écran virtuel.** Android relaie une surface plus petite. À
///     densité constante, il y voit un très petit téléphone et dessine tout en
///     énorme : une fenêtre de 360 px à 320 ppp ne fait que 180 dp de large.
///     Il faut donc réduire la densité dans la même proportion, sans quoi le
///     contenu grossit au lieu de rétrécir.
///
/// La première demande `--window-width`/`--window-height`, que scrcpy refuse
/// quand `--flex-display` est actif — puisque c'est alors la fenêtre qui
/// commande la définition. On prend donc l'un ou l'autre selon le réglage.
function sizing(settings) {
  const part = Math.min(1, Math.max(0.25, Number(settings.windowScale) || 0.55));
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const width = settings.width || 1280;
  const height = settings.height || 800;
  const tenir = Math.min(1, (sw * part) / width, (sh * part) / height);

  if (!settings.flex) {
    if (tenir >= 1) return {};
    // Une seule dimension : scrcpy déduit l'autre et garde le rapport, ce qui
    // évite les bandes noires.
    return (sw * part) / width < (sh * part) / height
      ? { windowWidth: Math.max(280, Math.round(width * tenir)) }
      : { windowHeight: Math.max(280, Math.round(height * tenir)) };
  }

  // En dessous de 360 px sur son petit côté, une application Android n'a plus
  // de mise en page utilisable. Le plancher s'applique au facteur, pas à
  // chaque dimension : autrement la forme se déformerait aux petites tailles.
  const plancher = 360 / Math.min(width, height);
  const facteur = Math.max(plancher, tenir);
  const pair = (n) => Math.round(n / 2) * 2;

  return {
    width: pair(width * facteur),
    height: pair(height * facteur),
    // La densité suit la définition : même nombre de « dp », donc la même
    // mise en page, simplement dessinée sur moins de pixels.
    dpi: Math.max(72, Math.round((settings.dpi || 160) * facteur)),
  };
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
  const app_ = appsCache.apps.find((a) => a.package === pkg) || { package: pkg, name: pkg };
  // Trois couches, de la plus générale à la plus précise : réglages communs,
  // réglages mémorisés pour cette application, puis le choix d'un seul
  // lancement.
  const settings = { ...store.all, ...store.overrideFor(pkg), ...(once || {}) };
  Object.assign(settings, sizing(settings));
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

// ── Diagnostic ──────────────────────────────────────────────────────────────

async function gatherDiagnostic() {
  const report = await device.diagnostics(current.serial);
  report.aura = app.getVersion();
  report.tools = await windows.tools();
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
      : `Fenêtres : wmctrl ${outils.wmctrl ? 'oui' : 'non'}, xdotool ${outils.xdotool ? 'oui' : 'non'}, python3-xlib ${outils.xlib ? 'oui' : 'non'}`
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
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  diagWin.loadFile(path.join(__dirname, '..', 'ui', 'diagnostic.html'));
  diagWin.on('closed', () => { diagWin = null; });
  return diagWin;
}

// ── Canaux ──────────────────────────────────────────────────────────────────

function registerIpc() {
  ipcMain.handle('bootstrap', async () => {
    const state = await connect();
    return {
      settings: store.all,
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
    return windows.toggle(session.child.pid);
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
  ipcMain.handle('wallpaper:refresh', async () => { await captureWallpaper(); });
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
  });

  app.on('window-all-closed', () => { /* le lanceur vit dans la barre système */ });

  app.on('will-quit', () => {
    clearInterval(watchTimer);
    globalShortcut.unregisterAll();
    // Laisser des scrcpy orphelins laisserait aussi des écrans virtuels ouverts
    // sur le téléphone.
    for (const session of sessions.values()) {
      try { session.child.kill('SIGTERM'); } catch (_) {}
    }
  });
}
