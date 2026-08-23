'use strict';
// Pont entre l'interface et le processus principal. La liste est explicite :
// rien d'autre que ces canaux n'est joignable depuis la page.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

/// Le chemin d'un fichier déposé sur la fenêtre.
///
/// `File.path` n'existe plus depuis Electron 32 : la page n'a plus le droit de
/// connaître l'arborescence de la machine. Seul le préchargement peut faire la
/// traduction, et c'est très bien ainsi — l'interface ne manipule qu'un objet
/// que l'utilisateur a lui-même déposé.
const cheminDuFichier = (file) => {
  try {
    return webUtils.getPathForFile(file) || null;
  } catch (_) {
    return null;
  }
};

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
  pathForFile: cheminDuFichier,
  sendFiles: (demandes) => invoke('bridge:send', demandes),
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
});
