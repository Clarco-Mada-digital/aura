'use strict';
// Journal de bord.
//
// Aura tourne sans terminal : lancée depuis un menu, une AppImage ou un
// raccourci, sa sortie standard ne va nulle part. Quand une application refuse
// de s'ouvrir sur une machine et pas sur une autre, il faut pourtant pouvoir
// lire ce que scrcpy a dit. Tout passe donc par un fichier que l'utilisateur
// peut ouvrir et envoyer tel quel.

const fs = require('fs');
const path = require('path');

const TAILLE_MAX = 512 * 1024;

let fichier = null;

/// Installe le journal dans le dossier de configuration de l'application.
function init(dossier) {
  try {
    fs.mkdirSync(dossier, { recursive: true });
    fichier = path.join(dossier, 'aura.log');
    // Rotation simple : un seul fichier précédent conservé. Deux suffisent à
    // couvrir « ça marchait avant-hier », et rien ne grossit sans fin.
    const stat = fs.existsSync(fichier) ? fs.statSync(fichier) : null;
    if (stat && stat.size > TAILLE_MAX) fs.renameSync(fichier, `${fichier}.1`);
    write('—', `Aura démarre — ${process.platform}/${process.arch}, Electron ${process.versions.electron || '?'}`);
  } catch (_) {
    fichier = null;
  }
  return fichier;
}

function write(niveau, message, details) {
  const ligne = `${new Date().toISOString()} ${niveau} ${message}${details ? `\n${details}` : ''}\n`;
  if (process.env.AURA_DEBUG) process.stderr.write(ligne);
  if (!fichier) return;
  try {
    fs.appendFileSync(fichier, ligne);
  } catch (_) {}
}

const info = (message, details) => write('INFO', message, details);
const warn = (message, details) => write('WARN', message, details);
const error = (message, details) => write('ERR ', message, details);

function chemin() {
  return fichier;
}

/// Les dernières lignes, pour les afficher dans l'application.
function tail(lignes = 200) {
  if (!fichier || !fs.existsSync(fichier)) return '';
  try {
    const texte = fs.readFileSync(fichier, 'utf8');
    return texte.split('\n').slice(-lignes).join('\n');
  } catch (err) {
    return String(err.message);
  }
}

module.exports = { init, info, warn, error, chemin, tail };
