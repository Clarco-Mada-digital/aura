'use strict';
// Pont entre l'interface et le processus principal. La liste est explicite :
// rien d'autre que ces canaux n'est joignable depuis la page.

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('aura', {
  bootstrap: () => invoke('bootstrap'),
  refreshDevice: () => invoke('device:refresh'),
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
  diagnostics: () => invoke('diag:get'),
  diagnosticText: () => invoke('diag:text'),
  openDiagnostic: () => invoke('diag:window'),
  logTail: () => invoke('diag:log'),
  openLog: () => invoke('diag:open'),

  onNotifications: (fn) => ipcRenderer.on('notifications:changed', (_e, list) => fn(list)),
  onSessions: (fn) => ipcRenderer.on('sessions:changed', (_e, list) => fn(list)),
  onFailure: (fn) => ipcRenderer.on('session:failed', (_e, info) => fn(info)),
  onShown: (fn) => ipcRenderer.on('launcher:shown', () => fn()),
  onEngineProgress: (fn) => ipcRenderer.on('engine:progress', (_e, p) => fn(p)),
  onWallpaper: (fn) => ipcRenderer.on('wallpaper:frame', (_e, frame) => fn(frame)),
});
