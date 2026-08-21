'use strict';
// Mise à jour automatique.
//
// Sans elle, chaque correction demande à l'utilisateur d'aller chercher un
// fichier sur GitHub, de le télécharger, de remplacer l'ancien. Sur trois
// machines et trois systèmes, cela ne se fait pas — et le logiciel installé
// reste vieux, quelle que soit la qualité des versions publiées.
//
// Deux garde-fous :
//
//   1. Rien ne se télécharge sans l'accord de l'utilisateur. La vérification
//      est silencieuse, l'installation ne l'est pas.
//   2. Rien ne s'installe en pleine session. Le paquet est posé, et remplace
//      l'application au prochain démarrage — ou tout de suite si on le
//      demande.

const { autoUpdater } = require('electron-updater');

const log = require('./log');

let etat = { statut: 'inconnu', version: null, notes: null, progression: 0, erreur: null };
let prevenir = () => {};
let demarre = false;

function pousser(patch) {
  etat = { ...etat, ...patch };
  prevenir(etat);
}

/// Prépare le vérificateur. À n'appeler qu'une fois.
///
/// `autoDownload` est désactivé : sur une connexion facturée au volume — la
/// règle plutôt que l'exception là où ce logiciel est écrit — une centaine de
/// mégaoctets ne se prend pas sans prévenir.
function init(onChange) {
  if (demarre) return etat;
  demarre = true;
  prevenir = typeof onChange === 'function' ? onChange : () => {};

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m) => log.info(`maj: ${m}`),
    warn: (m) => log.warn(`maj: ${m}`),
    error: (m) => log.error(`maj: ${m}`),
    debug: () => {},
  };

  autoUpdater.on('update-available', (info) => {
    log.info(`mise à jour disponible : ${info.version}`);
    pousser({ statut: 'disponible', version: info.version, notes: info.releaseName || null, erreur: null });
  });
  autoUpdater.on('update-not-available', () => pousser({ statut: 'à jour', version: null, erreur: null }));
  autoUpdater.on('download-progress', (p) => pousser({ statut: 'téléchargement', progression: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => {
    log.info(`mise à jour prête : ${info.version}`);
    pousser({ statut: 'prête', version: info.version, progression: 100 });
  });
  autoUpdater.on('error', (err) => {
    log.warn(`maj: ${err && err.message}`);
    pousser({ statut: 'erreur', erreur: err && err.message ? err.message : String(err) });
  });

  return etat;
}

/// Interroge la publication GitHub. Silencieux : rien ne s'affiche s'il n'y a
/// rien de neuf.
async function check() {
  pousser({ statut: 'vérification', erreur: null });
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    pousser({ statut: 'erreur', erreur: err && err.message ? err.message : String(err) });
  }
  return etat;
}

async function download() {
  pousser({ statut: 'téléchargement', progression: 0, erreur: null });
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    pousser({ statut: 'erreur', erreur: err && err.message ? err.message : String(err) });
  }
  return etat;
}

/// Remplace l'application et redémarre.
function install() {
  autoUpdater.quitAndInstall(false, true);
}

const state = () => etat;

module.exports = { init, check, download, install, state };
