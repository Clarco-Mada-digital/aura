'use strict';
// Réglages, favoris et historique, dans un simple fichier JSON.
//
// L'écriture passe par un fichier temporaire renommé : une coupure en cours
// d'écriture laisserait sinon un JSON tronqué, et l'application démarrerait
// sans favoris.

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // Fenêtre d'application (écran virtuel Android).
  width: 1280,
  height: 800,
  // 160 ppp donne une mise en page « tablette » ; la densité native du
  // téléphone (420) produirait une interface mobile étirée sur grand écran.
  dpi: 160,
  flex: true,
  keepActive: true,
  audio: false,
  codec: 'h264',
  bitrate: '8M',
  maxFps: 60,
  noSystemDecorations: false,

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
  freeHeight: false,
  showSystemApps: false,
  favorites: [],
  recents: [],
  // Réglages propres à une application, par paquet. Certaines forcent leur
  // orientation et entrent en boucle avec le suivi de fenêtre (voir
  // `overrideFor`).
  overrides: {},
  serial: null,
};

class Store {
  constructor(file) {
    this.file = file;
    this.data = { ...DEFAULTS };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...DEFAULTS, ...raw };
    } catch (_) {
      // Premier lancement, ou fichier illisible : les valeurs par défaut font
      // très bien l'affaire.
    }
  }

  get all() { return this.data; }
  get(key) { return this.data[key]; }

  set(patch) {
    this.data = { ...this.data, ...patch };
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
    const overrides = { ...(this.data.overrides || {}) };
    if (patch === null) delete overrides[pkg];
    else overrides[pkg] = { ...(overrides[pkg] || {}), ...patch };
    this.set({ overrides });
    return overrides[pkg] || null;
  }

  // Historique court : les huit dernières applications ouvertes, sans doublon.
  remember(pkg) {
    const recents = [pkg, ...this.data.recents.filter((p) => p !== pkg)].slice(0, 8);
    this.set({ recents });
    return recents;
  }
}

module.exports = { Store, DEFAULTS };
