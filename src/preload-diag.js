'use strict';
// Pont de la fenêtre de diagnostic, et rien de plus.
//
// Cette fenêtre affiche un rapport et le journal. Elle n'a aucun besoin
// d'envoyer des fichiers au téléphone, de rejoindre un réseau Wi-Fi ou de
// lancer une application — or c'est bien tout cela qu'elle recevait, en
// réutilisant le préchargement du lanceur. Une surface d'attaque ne se justifie
// pas par la commodité de n'écrire qu'un fichier.

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('aura', {
  diagnostics: () => invoke('diag:get'),
  diagnosticText: () => invoke('diag:text'),
  logTail: () => invoke('diag:log'),
  openLog: () => invoke('diag:open'),
});
