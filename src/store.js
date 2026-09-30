'use strict';
// Réglages, favoris et historique, dans un simple fichier JSON.
//
// L'écriture passe par un fichier temporaire renommé : une coupure en cours
// d'écriture laisserait sinon un JSON tronqué, et l'application démarrerait
// sans favoris.

const fs = require('fs');
const path = require('path');

const log = require('./log');

const DEFAULTS = {
  // Fenêtre d'application (écran virtuel Android).
  width: 1280,
  height: 800,
  // 160 ppp donne une mise en page « tablette » ; la densité native du
  // téléphone (420) produirait une interface mobile étirée sur grand écran.
  dpi: 160,
  // Décoché, l'écran virtuel garde sa définition et scrcpy met l'image à
  // l'échelle : la mise en page reste celle du téléphone, en plus petit et
  // plus net. C'est ce qu'on attend d'une fenêtre qu'on rétrécit.
  flex: false,
  keepActive: true,
  audio: false,
  codec: 'h264',
  bitrate: '8M',
  maxFps: 60,
  noSystemDecorations: false,
  // Part de l'écran occupée par la fenêtre d'application à son ouverture.
  //
  // La définition de l'écran virtuel (1280 × 800) décide de la *netteté* ; ce
  // réglage décide de la *taille à l'écran*. Sans lui, une fenêtre s'ouvrait
  // à sa définition pixel pour pixel — soit un pavé de 1280 px de large, bien
  // plus gros que ce qu'on attend d'une application de téléphone posée à côté
  // de son travail.
  windowScale: 0.55,

  // Lanceur.
  // Ctrl+Espace appartient aux méthodes de saisie, Alt+Espace au menu de
  // fenêtre : ni l'un ni l'autre ne fait un bon raccourci de lanceur.
  hotkey: 'Ctrl+Alt+Space',
  alwaysOnTop: true,
  // Le widget reste en place : il ne s'efface ni au clic ailleurs, ni quand
  // une application s'ouvre. L'épingle rend le comportement « projecteur ».
  pinned: true,
  hideAfterLaunch: false,
  blurWallpaper: true,
  // Alerte du bureau à chaque nouvelle notification du téléphone, et widget
  // ramené au premier plan pour un appel entrant.
  desktopNotifications: true,
  raiseOnCall: true,
  // Un appel entrant s'affiche sur l'écran principal du téléphone : sans
  // miroir, il n'y a rien à voir depuis l'ordinateur.
  mirrorOnCall: true,
  // Composeur par défaut, pour l'appel sortant depuis la barre de recherche.
  dialer: 'com.samsung.android.dialer',
  // Applications liées : ce qui surgit sur l'écran du téléphone parce qu'une
  // fenêtre Aura l'a demandé (« envoyer un message », « ouvrir avec »…).
  //   'off'  ne rien faire
  //   'ask'  le proposer, sans rien imposer
  //   'auto' ouvrir aussitôt la fenêtre correspondante
  followLaunches: 'ask',
  // Sous Wayland, faire passer les fenêtres d'application par XWayland. Elles
  // restent alors pilotables — cliquer sur une vignette ramène la fenêtre — au
  // prix d'un peu de netteté aux échelles fractionnaires. Sans effet sous X11.
  xwayland: true,
  // Les boîtes de dialogue du système — choix de la carte SIM, « ouvrir avec »,
  // demande de permission — ne savent pas s'afficher sur un écran virtuel.
  // Sans le miroir, il n'y a rien à valider depuis l'ordinateur.
  mirrorOnDialog: true,
  freeHeight: false,
  // Vérifie les publications au démarrage et télécharge en fond. L'install
  // reste un geste volontaire.
  autoUpdate: true,
  showSystemApps: false,
  favorites: [],
  recents: [],
  // Réglages propres à une application, par paquet. Certaines forcent leur
  // orientation et entrent en boucle avec le suivi de fenêtre (voir
  // `overrideFor`).
  overrides: {},
  serial: null,
};

// ── Validation ──────────────────────────────────────────────────────────────
//
// Les réglages ne viennent pas seulement du fichier : la page les écrit par le
// canal `settings:set`. Or plusieurs d'entre eux finissent sur la ligne de
// commande de scrcpy (`--video-codec`, `--new-display=…`) ou servent de nom de
// paquet à lancer (`dialer`). Rien n'y est passé à un shell — `spawn` reçoit un
// tableau — mais laisser la page écrire n'importe quoi dans n'importe quelle
// clé n'est pas une propriété qu'on veut devoir démontrer à chaque relecture.
//
// Une clé inconnue est ignorée, une valeur hors bornes aussi : un réglage qui
// ne peut pas être honoré ne doit ni s'écrire, ni faire tomber l'application.

const PACKAGE = /^[A-Za-z0-9_](?:[A-Za-z0-9_.]*[A-Za-z0-9_])?$/;

/// Ce qu'un numéro de série d'appareil peut contenir : celui d'un téléphone
/// branché (`R58M80ABCDE`) comme celui d'un appareil réseau (`192.168.1.5:5555`).
const SERIAL = /^[A-Za-z0-9._:-]{1,64}$/;

const bool = { type: 'bool' };
const entier = (min, max) => ({ type: 'int', min, max });

/// Réglages qui décrivent une fenêtre d'application. Ils valent en général et
/// peuvent être redéfinis par paquet, d'où la table séparée.
const FENETRE = {
  width: entier(320, 7680),
  height: entier(320, 7680),
  dpi: entier(72, 640),
  flex: bool,
  keepActive: bool,
  audio: bool,
  codec: { type: 'enum', values: ['h264', 'h265', 'av1'] },
  // `8M`, `2000K`, `4000000` : les trois formes que scrcpy accepte.
  bitrate: { type: 'motif', motif: /^[1-9][0-9]{0,8}[KM]?$/ },
  maxFps: entier(1, 240),
  noSystemDecorations: bool,
  windowScale: { type: 'nombre', min: 0.25, max: 1 },
  captureOrientation: { type: 'enum', values: ['0', '90', '180', '270', 'flip0', 'flip90', 'flip180', 'flip270'] },
};

const SCHEMA = {
  ...FENETRE,

  hotkey: { type: 'texte', max: 64 },
  alwaysOnTop: bool,
  pinned: bool,
  hideAfterLaunch: bool,
  blurWallpaper: bool,
  desktopNotifications: bool,
  raiseOnCall: bool,
  mirrorOnCall: bool,
  mirrorOnDialog: bool,
  followLaunches: { type: 'enum', values: ['off', 'ask', 'auto'] },
  xwayland: bool,
  freeHeight: bool,
  autoUpdate: bool,
  showSystemApps: bool,

  dialer: { type: 'paquet' },
  favorites: { type: 'paquets' },
  recents: { type: 'paquets' },
  overrides: { type: 'surcharges' },
  serial: { type: 'serial' },
};

/// La valeur retenue, ou `undefined` si elle n'est pas acceptable.
function valide(regle, value) {
  switch (regle.type) {
    case 'bool':
      return typeof value === 'boolean' ? value : undefined;

    case 'int': {
      const n = Number(value);
      if (!Number.isFinite(n)) return undefined;
      const r = Math.round(n);
      return r >= regle.min && r <= regle.max ? r : undefined;
    }

    case 'nombre': {
      const n = Number(value);
      return Number.isFinite(n) && n >= regle.min && n <= regle.max ? n : undefined;
    }

    case 'enum':
      return regle.values.includes(value) ? value : undefined;

    case 'motif':
      return typeof value === 'string' && regle.motif.test(value) ? value : undefined;

    case 'texte':
      return typeof value === 'string' && value.length <= regle.max ? value : undefined;

    case 'paquet':
      return typeof value === 'string' && PACKAGE.test(value) ? value : undefined;

    case 'paquets':
      // Une liste de favoris hors d'usage vaudrait mieux qu'un favori douteux :
      // on filtre plutôt que de rejeter l'ensemble.
      return Array.isArray(value)
        ? [...new Set(value.filter((p) => typeof p === 'string' && PACKAGE.test(p)))]
        : undefined;

    case 'serial':
      if (value === null) return null;
      return typeof value === 'string' && SERIAL.test(value) ? value : undefined;

    case 'surcharges': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
      const propre = {};
      for (const [pkg, patch] of Object.entries(value)) {
        if (!PACKAGE.test(pkg) || !patch || typeof patch !== 'object') continue;
        const retenu = nettoyer(patch, FENETRE);
        if (Object.keys(retenu).length) propre[pkg] = retenu;
      }
      return propre;
    }

    default:
      return undefined;
  }
}

/// Deux réglages sont-ils le même ? Les listes et les tables comptent, d'où la
/// comparaison par sérialisation plutôt que par identité.
function memeValeur(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/// Le patch débarrassé de ce qui n'a pas sa place, et la liste des refus.
function nettoyer(patch, schema = SCHEMA, refus = []) {
  const retenu = {};
  if (!patch || typeof patch !== 'object') return retenu;

  for (const [key, value] of Object.entries(patch)) {
    const regle = schema[key];
    if (!regle) { refus.push(key); continue; }
    const propre = valide(regle, value);
    if (propre === undefined) { refus.push(key); continue; }
    retenu[key] = propre;
  }
  return retenu;
}

class Store {
  constructor(file) {
    this.file = file;
    this.data = { ...DEFAULTS };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // Le fichier passe par la même porte que la page : il a pu être modifié à
      // la main, ou écrit par une version dont les réglages ont changé de forme.
      this.data = { ...DEFAULTS, ...nettoyer(raw) };
    } catch (_) {
      // Premier lancement, ou fichier illisible : les valeurs par défaut font
      // très bien l'affaire.
    }
  }

  get all() { return this.data; }
  get(key) { return this.data[key]; }

  /// Applique ce qui est applicable, et seulement cela.
  ///
  /// Retourne l'état complet — l'appelant s'en sert pour répondre à la page, qui
  /// se réaligne ainsi d'elle-même sur ce qui a réellement été retenu.
  set(patch) {
    const refus = [];
    const propre = nettoyer(patch, SCHEMA, refus);
    if (refus.length) log.warn(`réglages ignorés : ${refus.join(', ')}`);

    // Une écriture qui ne change rien n'en est pas une. `connect()` repose le
    // même numéro de série à chaque reconnexion — toutes les minutes — et sans
    // ce filtre le fichier de configuration était réécrit à chaque passage.
    const change = Object.keys(propre).filter((key) => !memeValeur(this.data[key], propre[key]));
    if (!change.length) return this.data;

    this.data = { ...this.data, ...propre };
    this.save();
    return this.data;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (_) { /* un réglage perdu ne vaut pas un plantage */ }
  }

  toggleFavorite(pkg) {
    const favorites = this.data.favorites.includes(pkg)
      ? this.data.favorites.filter((p) => p !== pkg)
      : [...this.data.favorites, pkg];
    this.set({ favorites });
    return favorites;
  }

  reorderFavorites(order) {
    // On ne garde que des paquets déjà favoris : l'interface peut se tromper,
    // pas le fichier.
    const known = new Set(this.data.favorites);
    const favorites = order.filter((p) => known.has(p));
    for (const pkg of this.data.favorites) if (!favorites.includes(pkg)) favorites.push(pkg);
    this.set({ favorites });
    return favorites;
  }

  /// Réglages d'une application, fusionnés par-dessus les réglages généraux.
  ///
  /// Le suivi de fenêtre (`--flex-display`) redimensionne l'écran Android quand
  /// la fenêtre bouge. Avec une application qui impose son orientation —
  /// Facebook en mode story, par exemple — les deux se répondent sans fin :
  /// l'application demande le portrait, l'écran tourne, la fenêtre est
  /// redimensionnée, le suivi remet le format de la fenêtre, l'application
  /// redemande le portrait. La sortie de boucle est de figer l'écran pour cette
  /// application-là.
  overrideFor(pkg) {
    return (this.data.overrides || {})[pkg] || {};
  }

  setOverride(pkg, patch) {
    if (!PACKAGE.test(String(pkg || ''))) return null;
    const overrides = { ...(this.data.overrides || {}) };
    if (patch === null) delete overrides[pkg];
    else overrides[pkg] = { ...(overrides[pkg] || {}), ...patch };
    this.set({ overrides });
    // Ce qui est relu, et non ce qui a été demandé : la validation a pu écarter
    // une partie du patch, et la page doit voir l'état réel.
    const retenu = this.overrideFor(pkg);
    return Object.keys(retenu).length ? retenu : null;
  }

  // Historique court : les huit dernières applications ouvertes, sans doublon.
  remember(pkg) {
    const recents = [pkg, ...this.data.recents.filter((p) => p !== pkg)].slice(0, 8);
    this.set({ recents });
    return recents;
  }
}

module.exports = { Store, DEFAULTS, SCHEMA, nettoyer, PACKAGE };
