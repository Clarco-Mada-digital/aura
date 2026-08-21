'use strict';
// Icônes réelles des applications.
//
// Android ne sait pas livrer l'icône d'une application par ADB : il n'existe
// aucune commande « pm get-icon ». La seule source est l'APK. Or les APK sont
// gros — une centaine de mégaoctets pour certaines applications système. On ne
// rapatrie donc que les octets utiles : le sommaire du zip, puis la seule
// entrée de l'icône. Quelques dizaines de kilo-octets, et le résultat est
// conservé sur disque : le coût n'est payé qu'une fois.
//
// Le chemin exact de l'icône est déclaré dans le manifeste compilé et résolu
// par resources.arsc, deux formats binaires propres à Android. Les décoder ici
// coûterait un analyseur complet de ressources pour un gain marginal : le
// sommaire du zip suffit à reconnaître l'icône par son nom, convention que
// respectent les outils de construction d'Android. Une application dont
// l'icône n'est qu'un XML (icône adaptative sans rendu matriciel) ne donne
// rien : l'interface retombe alors sur sa pastille colorée.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const arsc = require('./arsc');

const QUEUE = 66000;          // fin de fichier lue pour retrouver le sommaire
const TAILLE_MAX = 512 * 1024; // au-delà, ce n'est pas une icône
const TAILLE_MIN = 256;        // en deçà, c'est un pixel de remplissage
const ESSAIS_MAX = 4;

function execBin(bin, args, timeout = 25000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout }, (err, stdout) => {
      if (err && (!stdout || !stdout.length)) return reject(err);
      resolve(stdout);
    });
  });
}

function scoreName(name) {
  const low = name.toLowerCase();
  if (!low.endsWith('.png') && !low.endsWith('.webp')) return 0;
  if (!low.startsWith('res/')) return 0;
  // Icônes de notification, de raccourci ou de widget : noms voisins, mais ce
  // n'est pas l'application.
  if (low.includes('notification') || low.includes('_stat_')) return 0;
  if (low.includes('ic_launcher')) return 3;
  if (low.includes('/mipmap') && low.includes('icon')) return 3;
  if (low.includes('icon')) return 2;
  if (low.includes('/mipmap')) return 1;
  return 0;
}

function isImage(buf) {
  if (!buf || buf.length < 12) return false;
  const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const webp = buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP';
  return png || webp;
}

function mime(buf) {
  return buf[0] === 0x89 ? 'image/png' : 'image/webp';
}

// Fin du sommaire central (EOCD) : « PK\x05\x06 » suivi des tailles.
function centralDirectory(queue) {
  for (let i = queue.length - 22; i >= 0; i--) {
    if (queue[i] === 0x50 && queue[i + 1] === 0x4b && queue[i + 2] === 0x05 && queue[i + 3] === 0x06) {
      const size = queue.readUInt32LE(i + 12);
      const offset = queue.readUInt32LE(i + 16);
      if (size > 0 && size < 64 * 1024 * 1024) return { offset, size };
    }
  }
  throw new Error('sommaire du zip introuvable');
}

function readCentralDirectory(buf) {
  const entries = [];
  let i = 0;
  while (i + 46 <= buf.length) {
    if (buf.readUInt32LE(i) !== 0x02014b50) break;
    const method = buf.readUInt16LE(i + 10);
    const compressed = buf.readUInt32LE(i + 20);
    const size = buf.readUInt32LE(i + 24);
    const nameLen = buf.readUInt16LE(i + 28);
    const extraLen = buf.readUInt16LE(i + 30);
    const commentLen = buf.readUInt16LE(i + 32);
    const offset = buf.readUInt32LE(i + 42);
    const name = buf.slice(i + 46, i + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compressed, size, offset });
    i += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

class IconStore {
  constructor({ adbPath, serial, dir }) {
    this.adbPath = adbPath;
    this.serial = serial;
    this.dir = dir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.missing = new Set();
    // Un seul canal USB relie l'ordinateur au téléphone : vingt extractions de
    // front ne vont pas plus vite, elles rament toutes. On sérialise.
    this.queue = Promise.resolve();
  }

  cachePath(pkg) { return path.join(this.dir, `${pkg}.img`); }
  missPath(pkg) { return path.join(this.dir, `${pkg}.aucune`); }

  // Reprend les icônes déjà extraites par OpenDex, s'il en a laissé.
  importFrom(dirs) {
    let count = 0;
    for (const src of dirs) {
      if (!src || !fs.existsSync(src)) continue;
      for (const entry of fs.readdirSync(src)) {
        const target = path.join(this.dir, entry);
        if (fs.existsSync(target)) continue;
        try { fs.copyFileSync(path.join(src, entry), target); count++; } catch (_) {}
      }
    }
    return count;
  }

  cached(pkg) {
    try {
      const buf = fs.readFileSync(this.cachePath(pkg));
      if (isImage(buf)) return { data: buf.toString('base64'), mime: mime(buf) };
    } catch (_) {}
    if (this.missing.has(pkg)) return null;
    if (fs.existsSync(this.missPath(pkg))) { this.missing.add(pkg); return null; }
    return undefined; // « on ne sait pas encore »
  }

  async icon(pkg) {
    const known = this.cached(pkg);
    if (known !== undefined) return known;

    const task = this.queue.then(() => this._extract(pkg));
    // Un échec ne doit pas bloquer la file pour les paquets suivants.
    this.queue = task.catch(() => {});
    let buf = null;
    try { buf = await task; } catch (_) { buf = null; }

    if (buf) {
      try { fs.writeFileSync(this.cachePath(pkg), buf); } catch (_) {}
      return { data: buf.toString('base64'), mime: mime(buf) };
    }
    // Une absence comme un échec se retiennent : sans cela, chaque ouverture du
    // lanceur réinterrogerait l'appareil, et chaque essai coûte des secondes.
    this.missing.add(pkg);
    try { fs.writeFileSync(this.missPath(pkg), ''); } catch (_) {}
    return null;
  }

  async _read(apk, from, size) {
    // Le chemin est fourni par `pm path`, mais il repart vers un shell : une
    // apostrophe suffirait à en sortir.
    const path_ = String(apk).replace(/'/g, `'\\''`);
    // `adb exec-out` transporte les octets tels quels, sans traduction de fin
    // de ligne. `tail -c +N` compte à partir de 1.
    const command =
      from === null
        ? `toybox tail -c ${size} '${path_}'`
        : `toybox tail -c +${from + 1} '${path_}' | toybox head -c ${size}`;
    const args = this.serial ? ['-s', this.serial, 'exec-out', command] : ['exec-out', command];
    return execBin(this.adbPath, args);
  }

  async _apkPath(pkg) {
    const args = this.serial ? ['-s', this.serial, 'shell'] : ['shell'];
    // Le nom de paquet vient de l'appareil, mais il traverse un shell : on le
    // vérifie plutôt que de lui faire confiance.
    if (!/^[A-Za-z0-9_](?:[A-Za-z0-9_.]*[A-Za-z0-9_])?$/.test(pkg)) {
      throw new Error(`nom de paquet invalide : « ${pkg} »`);
    }
    const out = await execBin(this.adbPath, [...args, `pm path --user 0 ${pkg}`], 15000);
    const lines = out.toString('utf8').split('\n').map((l) => l.trim());
    // Une application peut être découpée en plusieurs APK ; l'icône vit dans la
    // base, jamais dans les fragments de configuration.
    const paths = lines.filter((l) => l.startsWith('package:')).map((l) => l.slice(8).trim());
    const base = paths.find((p) => p.endsWith('base.apk')) || paths.find((p) => !p.includes('split_'));
    if (!base) throw new Error(`« ${pkg} » n'est pas installé pour le profil 0`);
    return base;
  }

  async _entryContent(apk, entry) {
    // L'en-tête local répète les longueurs de nom et d'extra, qui peuvent
    // différer de celles du sommaire : impossible de calculer la position des
    // données sans le lire.
    const head = await this._read(apk, entry.offset, 30);
    if (head.length < 30 || head.readUInt32LE(0) !== 0x04034b50) throw new Error('en-tête local illisible');
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    const data = await this._read(apk, entry.offset + 30 + nameLen + extraLen, entry.compressed);
    if (entry.method === 0) return data;
    // Une entrée annoncée à 500 Kio peut se décompresser en plusieurs gigaoctets :
    // le sommaire du zip n'engage que celui qui l'a écrit. On borne la sortie.
    if (entry.method === 8) {
      return zlib.inflateRawSync(data, { maxOutputLength: Math.min(TAILLE_MAX * 4, entry.size + 65536) });
    }
    throw new Error(`compression inconnue (${entry.method})`);
  }

  // Chemins d'icône déclarés dans la table de ressources de l'APK.
  async _declaredPaths(apk, entries) {
    const table = entries.find((e) => e.name === 'resources.arsc');
    if (!table) return [];
    // Une table démesurée trahit un fichier inhabituel ; la lire coûterait plus
    // que l'icône ne vaut.
    if (table.size > 24 * 1024 * 1024) return [];

    const content = await this._entryContent(apk, table);
    return arsc
      .fileResources(content, ['mipmap', 'drawable'])
      .map((r) => ({ score: arsc.scoreResource(r), path: r.path }))
      .filter((r) => r.score > 0);
  }

  async _extract(pkg) {
    const apk = await this._apkPath(pkg);
    const queue = await this._read(apk, null, QUEUE);
    const { offset, size } = centralDirectory(queue);
    const central = await this._read(apk, offset, size);
    const entries = readCentralDirectory(central);
    const byName = new Map(entries.map((e) => [e.name, e]));

    const usable = (e) => e && e.size >= TAILLE_MIN && e.size <= TAILLE_MAX;
    // À note égale, la plus grosse entrée l'emporte : c'est la version haute
    // densité.
    const rank = (a, b) => (b.score - a.score) || (b.entry.size - a.entry.size);

    // Quand un fichier s'appelle encore « ic_launcher », il n'y a rien à
    // chercher plus loin : le sommaire du zip est déjà lu, cette piste est
    // gratuite. La table de ressources, elle, coûte plusieurs mégaoctets.
    const byFileName = entries
      .map((e) => ({ score: scoreName(e.name), entry: e }))
      .filter((c) => c.score > 0 && usable(c.entry))
      .sort(rank);

    if (byFileName.length && byFileName[0].score === 3) {
      try {
        const content = await this._entryContent(apk, byFileName[0].entry);
        if (isImage(content)) return content;
      } catch (_) { /* on continue par la table */ }
    }

    // Le nom de la ressource survit au renommage des fichiers ; le nom du
    // fichier, lui, n'y survit pas.
    let declared = [];
    try {
      declared = await this._declaredPaths(apk, entries);
    } catch (_) { /* table illisible : on se rabat sur les noms de fichiers */ }

    const candidates = declared
      .map((d) => ({ score: d.score, entry: byName.get(d.path) }))
      .filter((c) => usable(c.entry))
      .sort(rank)
      .concat(byFileName);

    // Le meilleur candidat n'est pas toujours une image : une icône adaptative
    // est un XML, et rien dans la table ne le signale. On descend donc la liste
    // jusqu'à des octets affichables, sans s'acharner.
    const seen = new Set();
    let tries = 0;
    for (const candidate of candidates) {
      if (seen.has(candidate.entry.name)) continue;
      seen.add(candidate.entry.name);
      if (tries++ >= ESSAIS_MAX) break;
      try {
        const content = await this._entryContent(apk, candidate.entry);
        if (isImage(content)) return content;
      } catch (_) { /* candidat suivant */ }
    }
    return null;
  }

  clear() {
    for (const entry of fs.readdirSync(this.dir)) {
      try { fs.unlinkSync(path.join(this.dir, entry)); } catch (_) {}
    }
    this.missing.clear();
  }
}

function openDexCacheDirs() {
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return [path.join(data, 'opendex', 'icons', 'v2')];
}

module.exports = { IconStore, openDexCacheDirs, scoreName, isImage, centralDirectory, readCentralDirectory };
