'use strict';
// Pont du mode bureau.
//
// Il partage beaucoup avec celui du lanceur — même appareil, mêmes
// applications, mêmes notifications — et lui ajoute ce que seul un bureau
// demande : loger une fenêtre, la déplacer, la remonter. Il n'expose en revanche
// ni les réglages Wi-Fi ni l'envoi de fichiers, dont le bureau n'a que faire.

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (canal, ...args) => ipcRenderer.invoke(canal, ...args);

contextBridge.exposeInMainWorld('aura', {
  // Ce que le bureau sait de l'appareil
  bootstrap: () => invoke('desktop:bootstrap'),
  quickState: () => invoke('device:quickstate'),
  icon: (pkg) => invoke('icon:get', pkg),
  notifications: () => invoke('notifications:list'),
  dismissNotification: (key) => invoke('notifications:dismiss', key),

  // Applications
  launch: (pkg, once) => invoke('desktop:launch', pkg, once),
  closeSession: (id) => invoke('session:close', id),
  sessions: () => invoke('sessions:list'),

  // Fenêtres logées
  place: (id, boite) => invoke('desktop:place', id, boite),
  raise: (id) => invoke('desktop:raise', id),
  fold: (id, replie) => invoke('desktop:fold', id, replie),
  detach: (id) => invoke('desktop:detach', id),

  // Réglages propres au bureau : fond d'écran, widgets, icônes
  getLayout: () => invoke('desktop:layout:get'),
  setLayout: (patch) => invoke('desktop:layout:set', patch),
  pickWallpaper: () => invoke('desktop:wallpaper:pick'),

  close: () => invoke('desktop:close'),

  onSessions: (fn) => ipcRenderer.on('sessions:changed', (_e, l) => fn(l)),
  onNotifications: (fn) => ipcRenderer.on('notifications:changed', (_e, l) => fn(l)),
  onEmbedded: (fn) => ipcRenderer.on('desktop:embedded', (_e, info) => fn(info)),
  onResized: (fn) => ipcRenderer.on('desktop:resized', () => fn()),
});
