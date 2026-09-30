'use strict';
// Pont entre l'interface et le processus principal. La liste est explicite :
// rien d'autre que ces canaux n'est joignable depuis la page.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

// ── Fichiers déposés ────────────────────────────────────────────────────────
//
// `File.path` n'existe plus depuis Electron 32 : la page n'a plus le droit de
// connaître l'arborescence de la machine. Seul le préchargement peut faire la
// traduction — et il n'y a aucune raison de la lui rendre.
//
// Le chemin reste donc **ici**, derrière un jeton. La page reçoit de quoi
// afficher le dépôt (un nom, une extension) et de quoi le désigner (le jeton) ;
// elle n'apprend jamais où le fichier se trouve, et ne peut donc pas nommer un
// fichier que l'utilisateur n'a pas déposé lui-même.
//
// Ce n'était pas le cas jusqu'ici : `bridge:send` acceptait n'importe quel
// chemin venu de la page. La convention voulait qu'il provienne d'un vrai
// dépôt ; rien ne l'imposait. L'envoi se fait vers un appareil physique, hors de
// portée de tout contrôle réseau — c'est exactement le genre de propriété qui
// doit tenir par construction plutôt que par usage.

const déposés = new Map();
let prochainJeton = 1;

/// Un dépôt oublié ne garde pas un chemin joignable indéfiniment.
const JETONS_MAX = 64;

const décrire = (file) => {
  let chemin = null;
  try {
    chemin = webUtils.getPathForFile(file) || null;
  } catch (_) {
    return null;
  }
  if (!chemin) return null;

  const jeton = `d${prochainJeton++}`;
  déposés.set(jeton, chemin);
  while (déposés.size > JETONS_MAX) déposés.delete(déposés.keys().next().value);

  return { jeton, nom: chemin.split(/[\\/]/).pop() };
};

/// Résout les jetons, et les consomme : un dépôt s'envoie une fois.
const résoudre = (demandes) =>
  (Array.isArray(demandes) ? demandes : [])
    .map((d) => {
      const chemin = d && déposés.get(d.jeton);
      if (!chemin) return null;
      déposés.delete(d.jeton);
      return { path: chemin, action: d.action === 'install' ? 'install' : 'push' };
    })
    .filter(Boolean);

contextBridge.exposeInMainWorld('aura', {
  bootstrap: () => invoke('bootstrap'),
  refreshDevice: () => invoke('device:refresh'),
  devices: () => invoke('devices:list'),
  selectDevice: (serial) => invoke('device:select', serial),
  quickState: () => invoke('device:quickstate'),
  setVolume: (delta) => invoke('quick:volume', delta),
  setRinger: (mode) => invoke('quick:ringer', mode),
  setDnd: (on) => invoke('quick:dnd', on),
  setRadio: (radio, on) => invoke('quick:radio', radio, on),
  wifiList: (rescan = true) => invoke('wifi:list', rescan),
  wifiJoin: (demande) => invoke('wifi:join', demande),
  wifiForget: (id) => invoke('wifi:forget', id),
  wifiUnsuggest: (ssid) => invoke('wifi:unsuggest', ssid),
  wifiSuggestions: () => invoke('wifi:suggestions'),
  wifiSettings: () => invoke('wifi:settings'),
  décrireFichier: décrire,
  sendFiles: (demandes) => invoke('bridge:send', résoudre(demandes)),
  sendUrl: (url) => invoke('bridge:url', url),
  refreshApps: () => invoke('apps:refresh'),
  icon: (pkg) => invoke('icon:get', pkg),
  clearIcons: () => invoke('icons:clear'),
  launch: (pkg, once) => invoke('app:launch', pkg, once),
  overrideFor: (pkg) => invoke('overrides:get', pkg),
  setOverride: (pkg, patch) => invoke('overrides:set', pkg, patch),
  closeSession: (id) => invoke('session:close', id),
  toggleSession: (id) => invoke('session:toggle', id),
  installEngine: () => invoke('engine:install'),
  engineTarget: () => invoke('engine:target'),
  sessions: () => invoke('sessions:list'),
  notifications: () => invoke('notifications:list'),
  notificationKeys: () => invoke('notifications:keys'),
  dismissNotification: (key) => invoke('notifications:dismiss', key),
  dismissAllNotifications: (keys) => invoke('notifications:dismiss-all', keys),
  openShade: () => invoke('notifications:shade'),
  saveSettings: (patch) => invoke('settings:set', patch),
  toggleFavorite: (pkg) => invoke('favorites:toggle', pkg),
  reorderFavorites: (order) => invoke('favorites:reorder', order),
  fit: (height) => invoke('window:fit', height),
  hide: () => invoke('window:hide'),
  quit: () => invoke('window:quit'),
  refreshWallpaper: () => invoke('wallpaper:refresh'),
  openMirror: () => invoke('mirror:open'),
  acceptFollow: (pkg) => invoke('follow:accept', pkg),
  updateState: () => invoke('update:state'),
  checkUpdate: () => invoke('update:check'),
  downloadUpdate: () => invoke('update:download'),
  installUpdate: () => invoke('update:install'),
  callState: () => invoke('call:state'),
  answerCall: () => invoke('call:answer'),
  hangUpCall: () => invoke('call:hangup'),
  dial: (number) => invoke('call:dial', number),
  diagnostics: () => invoke('diag:get'),
  diagnosticText: () => invoke('diag:text'),
  openDiagnostic: () => invoke('diag:window'),
  logTail: () => invoke('diag:log'),
  openLog: () => invoke('diag:open'),

  onNotifications: (fn) => ipcRenderer.on('notifications:changed', (_e, list) => fn(list)),
  onSessions: (fn) => ipcRenderer.on('sessions:changed', (_e, list) => fn(list)),
  onUpdate: (fn) => ipcRenderer.on('update:changed', (_e, etat) => fn(etat)),
  onCall: (fn) => ipcRenderer.on('call:changed', (_e, call) => fn(call)),
  onFailure: (fn) => ipcRenderer.on('session:failed', (_e, info) => fn(info)),
  onShown: (fn) => ipcRenderer.on('launcher:shown', () => fn()),
  onEngineProgress: (fn) => ipcRenderer.on('engine:progress', (_e, p) => fn(p)),
  onWallpaper: (fn) => ipcRenderer.on('wallpaper:frame', (_e, frame) => fn(frame)),
  onTransfer: (fn) => ipcRenderer.on('transfer', (_e, info) => fn(info)),
  onHidden: (fn) => ipcRenderer.on('launcher:hidden', () => fn()),
  onFollow: (fn) => ipcRenderer.on('follow', (_e, info) => fn(info)),
});
