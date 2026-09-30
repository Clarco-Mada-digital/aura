'use strict';
// Couche appareil : tout ce qui parle à adb et à scrcpy passe par ici.
//
// Deux règles héritées du terrain :
//   1. `pm` et `am` visent le profil au premier plan. Sur un téléphone qui
//      héberge plusieurs profils (Secure Folder, Dual Messenger…), ils échouent
//      avec une SecurityException. On force donc toujours `--user 0`.
//   2. Les écrans virtuels (--new-display) n'existent qu'à partir de scrcpy 3.0.
//      Un scrcpy 1.25, encore livré par beaucoup de distributions, est refusé
//      franchement plutôt que toléré.

const { execFile, spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const session_ = require('./session');

const OWNER_USER = '0';

/// Guillemets simples POSIX : la seule façon sûre de passer une valeur au shell
/// de l'appareil.
///
/// Ce n'est pas théorique. La clé d'une notification contient l'étiquette
/// choisie par l'application qui l'a posée — texte libre, apostrophes
/// comprises — et elle est passée à `cmd notification`. Sans échappement, une
/// application malveillante peut faire exécuter ce qu'elle veut dans le shell
/// ADB du téléphone.
function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/// Un nom de paquet Android : lettres, chiffres, tiret bas, points.
const PACKAGE = /^[A-Za-z0-9_](?:[A-Za-z0-9_.]*[A-Za-z0-9_])?$/;

function assertPackage(pkg) {
  if (!PACKAGE.test(pkg || '')) throw new Error(`nom de paquet invalide : « ${pkg} »`);
  return pkg;
}
const MIN_SCRCPY = { major: 3, minor: 0 };

function run(bin, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        maxBuffer: 64 * 1024 * 1024,
        // `timeout: 0` désarme la minuterie — un envoi de fichier dure ce qu'il
        // dure. Le `||` d'usage l'aurait confondu avec « non précisé ».
        timeout: opts.timeout === 0 ? 0 : opts.timeout || 30000,
        encoding: opts.encoding || 'utf8',
        env: childEnv(),
      },
      (err, stdout, stderr) => resolve({ ok: !err, code: err ? err.code : 0, stdout: stdout || '', stderr: stderr || '' })
    );
  });
}

// ── Localisation des binaires ───────────────────────────────────────────────

const WINDOWS = process.platform === 'win32';
const EXE = WINDOWS ? '.exe' : '';

/// Dossier de données par système, aligné sur celui d'`install.js`.
function dataRoot() {
  if (WINDOWS) return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}

function engineCandidates() {
  const root = dataRoot();
  return [
    process.env.AURA_SCRCPY,
    path.join(root, 'aura', 'engine', `scrcpy${EXE}`),
    // OpenDex installe déjà un scrcpy récent : autant s'en servir.
    path.join(root, 'opendex', 'engine', `scrcpy${EXE}`),
    `scrcpy${EXE}`,
  ].filter(Boolean);
}

/// L'environnement transmis à scrcpy.
///
/// Aura peut tourner dans une AppImage, dont le lanceur préfixe
/// `LD_LIBRARY_PATH`, `PATH` et `XDG_DATA_DIRS` avec ses propres dossiers. Un
/// processus fils hérite de ces chemins et peut alors charger les
/// bibliothèques d'Electron au lieu de celles du système — scrcpy meurt sur
/// une erreur de symbole, sans rien afficher. On rend donc au fils un
/// environnement propre.
function childEnv(extra = null) {
  const env = { ...process.env, ...(extra || {}) };
  const appdir = env.APPDIR;
  if (!appdir) return env;
  for (const key of ['LD_LIBRARY_PATH', 'PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR', 'LD_PRELOAD', 'GTK_PATH', 'GDK_PIXBUF_MODULE_FILE', 'PERLLIB', 'PYTHONHOME', 'QT_PLUGIN_PATH']) {
    const value = env[key];
    if (!value) continue;
    const kept = value.split(path.delimiter).filter((part) => part && !part.startsWith(appdir));
    if (kept.length) env[key] = kept.join(path.delimiter);
    else delete env[key];
  }
  delete env.APPDIR;
  delete env.APPIMAGE;
  return env;
}

function parseVersion(banner) {
  const token = (banner.split('\n')[0] || '').split(/\s+/)[1];
  if (!token || !/^\d/.test(token)) return null;
  const [major, minor] = token.split(/[-+]/)[0].split('.');
  return { major: Number(major) || 0, minor: Number(minor) || 0, release: token };
}

let engineCache = null;

/// Oublie le moteur trouvé, après une installation par exemple.
function resetEngine() {
  engineCache = null;
}

async function findEngine() {
  if (engineCache) return engineCache;
  const rejected = [];
  for (const candidate of engineCandidates()) {
    const out = await run(candidate, ['--version'], { timeout: 8000 });
    const banner = out.stdout.trim() ? out.stdout : out.stderr;
    const version = parseVersion(banner);
    if (!version) continue;
    if (version.major > MIN_SCRCPY.major || (version.major === MIN_SCRCPY.major && version.minor >= MIN_SCRCPY.minor)) {
      engineCache = { path: candidate, version };
      return engineCache;
    }
    rejected.push({ path: candidate, version });
  }
  if (rejected.length) {
    const r = rejected[0];
    throw new Error(
      `scrcpy ${r.version.release} (${r.path}) est trop ancien : les fenêtres d'application ` +
        `exigent scrcpy 3.0+ (option --new-display). Installez le moteur depuis les réglages d'Aura.`
    );
  }
  throw new Error("aucun scrcpy trouvé. Installez le moteur depuis l'accueil d'Aura.");
}

function findAdb() {
  if (process.env.AURA_ADB) return process.env.AURA_ADB;
  if (engineCache) {
    const sibling = path.join(path.dirname(engineCache.path), `adb${EXE}`);
    if (fs.existsSync(sibling)) return sibling;
  }
  return `adb${EXE}`;
}

// ── ADB ─────────────────────────────────────────────────────────────────────

function adbArgs(serial, args) {
  return serial ? ['-s', serial, ...args] : args;
}

async function adb(serial, args, opts) {
  return run(findAdb(), adbArgs(serial, args), opts);
}

// ── Shell adb persistant ────────────────────────────────────────────────────
//
// Chaque `adb shell` isolé coûte ~300 ms : fork du processus, poignée de main
// avec le serveur adb, ouverture du shell. Le centre de contrôle en enchaîne
// quatre à l'ouverture, le sondage tourne toutes les 20 s, les appels toutes
// les 3 s — le câble passe son temps à établir des connexions jetables.
//
// Un unique `adb shell` maintenu ouvert, alimenté par son entrée standard,
// répond en ~20 ms. Chaque commande est terminée par un marqueur portant son
// numéro d'ordre et le code de sortie ; la lecture s'arrête au marqueur.

let shSession = null;
let shSeq = 0;

function closeShell() {
  if (!shSession) return;
  const session = shSession;
  shSession = null;
  for (const entry of session.pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error('shell adb fermé'));
  }
  session.pending.clear();
  try { session.proc.kill(); } catch (_) {}
}

function shellSession(serial) {
  if (shSession && shSession.serial === serial) return shSession;
  closeShell();

  const proc = spawn(findAdb(), adbArgs(serial, ['shell']), { stdio: ['pipe', 'pipe', 'pipe'] });
  const session = { serial, proc, pending: new Map(), buf: '' };
  shSession = session;

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    session.buf += chunk;
    // `adb shell` interactif passe par un pty : les lignes se terminent par
    // \r\n, et stderr se fond dans stdout — nos analyses tolèrent les deux.
    for (;;) {
      const m = /__AURA_(\d+)_(\d+)__\r?\n/.exec(session.buf);
      if (!m) break;
      const id = Number(m[1]);
      const entry = session.pending.get(id);
      const output = session.buf.slice(0, m.index);
      session.buf = session.buf.slice(m.index + m[0].length);
      if (!entry) continue;
      entry.output += output;
      session.pending.delete(id);
      clearTimeout(entry.timer);
      entry.resolve({ ok: m[2] === '0', code: Number(m[2]), stdout: entry.output, stderr: '' });
    }
  });

  // Perte du câble, arrêt du serveur adb, appareil débranché : on jette la
  // session ; la prochaine commande en rouvrira une propre.
  const abandon = () => {
    if (shSession !== session) return;
    shSession = null;
    for (const entry of session.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('connexion adb perdue'));
    }
    session.pending.clear();
  };
  proc.on('exit', abandon);
  proc.on('error', abandon);

  return session;
}

function pshell(serial, command, opts = {}) {
  const session = shellSession(serial);
  return new Promise((resolve, reject) => {
    const id = ++shSeq;
    const entry = {
      output: '',
      resolve,
      reject,
      timer: setTimeout(() => {
        session.pending.delete(id);
        reject(new Error(`délai dépassé : ${command.slice(0, 40)}`));
      }, opts.timeout || 8000),
    };
    session.pending.set(id, entry);
    // `$?` (code de sortie de la commande) ferme le marqueur. Chaîne simple :
    // pas d'interpolation, donc le dollar reste un dollar.
    session.proc.stdin.write(command + '; echo __AURA_' + id + '_$?__\n');
  });
}

async function shell(serial, command, opts) {
  try {
    const out = await pshell(serial, command, opts);
    return out.ok ? out.stdout : '';
  } catch (_) {
    // Même contrat que l'ancienne forme : une commande qui échoue répond du vide.
    return '';
  }
}

/// La même chose, mais sans jeter le verdict : `{ ok, code, stdout, stderr }`.
///
/// Les contrôles rapides ont besoin de distinguer « la commande a répondu du
/// vide » de « la commande a échoué » — ce que la forme texte de `shell` ne
/// permet pas.
function shellOut(serial, command, opts) {
  return pshell(serial, command, opts);
}

/// La même chose encore, mais qui ne jette jamais.
///
/// `pshell` rejette quand le délai passe ou que le câble tombe, là où `adb()`
/// répondait toujours un verdict. Les appels convertis du second au premier
/// gardent ainsi leur contrat : un échec est une valeur, pas une exception.
async function shellTry(serial, command, opts) {
  try {
    return await pshell(serial, command, opts);
  } catch (err) {
    return { ok: false, code: -1, stdout: '', stderr: err.message };
  }
}

async function startServer() {
  await run(findAdb(), ['start-server'], { timeout: 15000 });
}

async function listDevices() {
  const out = await run(findAdb(), ['devices'], { timeout: 15000 });
  const devices = [];
  for (const line of out.stdout.split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    devices.push({ serial: parts[0], state: parts[1] });
  }
  return devices;
}

async function deviceInfo(serial) {
  const [model, release, battery] = await Promise.all([
    shell(serial, 'getprop ro.product.model', { timeout: 8000 }),
    shell(serial, 'getprop ro.build.version.release', { timeout: 8000 }),
    shell(serial, 'dumpsys battery', { timeout: 8000 }),
  ]);
  const level = /^\s*level:\s*(\d+)/m.exec(battery);
  const status = /^\s*status:\s*(\d+)/m.exec(battery);
  return {
    serial,
    model: model.trim() || serial,
    android: release.trim(),
    battery: level ? Number(level[1]) : null,
    // status 2 = en charge, 5 = pleine.
    charging: status ? status[1] === '2' || status[1] === '5' : false,
  };
}

// ── Connectivité ────────────────────────────────────────────────────────────

/// État radio du téléphone, lu en un seul appel shell.
///
/// Chaque requête séparée coûterait un processus adb ; on les enchaîne donc
/// dans le même shell côté appareil. Les réglages `settings get` répondent en
/// quelques octets et existent sur toutes les versions d'Android supportées.
async function connectivity(serial) {
  const script = [
    'echo wifi=$(settings get global wifi_on)',
    'echo bt=$(settings get global bluetooth_on)',
    'echo plane=$(settings get global airplane_mode_on)',
    'echo data=$(settings get global mobile_data)',
    // wlan0 avec une adresse IP = réellement associé à un réseau.
    'ip addr show wlan0 2>/dev/null | grep -q "inet " && echo assoc=1 || echo assoc=0',
  ].join('; ');
  const out = await shellOut(serial, script, { timeout: 8000 }).catch(() => null);
  if (!out || !out.ok) return null;
  const get = (name) => {
    const m = new RegExp(`^${name}=(.*)$`, 'm').exec(out.stdout);
    return m ? m[1].trim() : null;
  };
  const on = (v) => v === '1';
  return {
    wifi: on(get('wifi')),
    wifiConnected: on(get('assoc')),
    bluetooth: on(get('bt')),
    airplane: on(get('plane')),
    mobileData: on(get('data')),
  };
}

// ── Contrôles rapides ───────────────────────────────────────────────────────

/// Ce qui, dans la réponse du shell, dit qu'un ordre n'est pas passé.
///
/// Ces commandes ne confirment rien quand elles réussissent — au mieux elles
/// annoncent ce qu'elles s'apprêtent à faire. Le refus, lui, est bavard :
/// binaire absent, permission manquante, exception Java. C'est donc lui qu'on
/// guette, plutôt qu'un accusé de réception qui n'existe pas.
const REFUS = /Exception|inaccessible or not found|not found|permission denied|denied|Failure|Killed|^Error:/im;

/// Touche matérielle injectée sur l'appareil.
const pressKey = (serial, code) => shell(serial, `input keyevent ${code}`, { timeout: 8000 });

/// Volume du flux média.
///
/// L'outil canonique est `cmd media_session`, mais toutes les ROM n'ont pas
/// le binaire `media` — les Samsung en sont dépourvus. On tente donc la cmd
/// d'abord, et l'ancien outil en secours.
async function mediaVolume(serial) {
  const cmd = await shellOut(serial, 'cmd media_session volume --stream 3 --get', { timeout: 8000 });
  // `cmd media_session` répond parfois sur la sortie d'erreur : on lit les deux.
  const m = /volume is (\d+) in range \[0\.\.(\d+)\]/i.exec(cmd.stdout + cmd.stderr);
  if (m) return { value: Number(m[1]), max: Number(m[2]) };

  const legacy = await shellOut(serial, 'media volume --stream 3 --get', { timeout: 8000 });
  const cur = /volume is (\d+)/i.exec(legacy.stdout + legacy.stderr);
  const max = /max is (\d+)/i.exec(legacy.stdout + legacy.stderr);
  if (!cur) return null;
  return { value: Number(cur[1]), max: max ? Number(max[1]) : 15 };
}

async function changeMediaVolume(serial, delta) {
  const now = await mediaVolume(serial);
  if (!now) throw new Error('volume média illisible sur cet appareil');
  const next = Math.max(0, Math.min(now.max, now.value + delta));
  // Poser un volume ne se relit pas dans la réponse : `cmd media_session` se
  // contente d'annoncer son intention (« [V] will set volume to index=7 »).
  // Exiger un « volume is » faisait tomber dans la solution de repli, absente
  // des Samsung — et tout échouait alors qu'il ne s'était rien passé de mal.
  // On juge donc sur le refus, pas sur la confirmation.
  const applique = async (command) => {
    const out = await shellOut(serial, command, { timeout: 8000 });
    return out.ok && !REFUS.test(out.stdout + out.stderr);
  };
  const posé =
    (await applique(`cmd media_session volume --stream 3 --set ${next}`)) ||
    (await applique(`media volume --stream 3 --set ${next}`));
  if (!posé) throw new Error('le réglage du volume a été refusé par l\'appareil');
  return { value: next, max: now.max };
}

/// Mode de sonnerie : 0 silencieux, 1 vibreur, 2 normal.
///
/// Le réglage passe par `settings put`, que le shell adb a le droit d'écrire ;
/// il est appliqué immédiatement par AudioService, sans redémarrage.
const RINGER = { silent: 0, vibrate: 1, normal: 2 };
async function ringerMode(serial) {
  const out = await shellOut(serial, 'settings get global mode_ringer', { timeout: 8000 });
  if (!out.ok) return null;
  const raw = out.stdout.trim();
  const found = Object.entries(RINGER).find(([, v]) => String(v) === raw);
  return found ? found[0] : null;
}

async function setRingerMode(serial, mode) {
  const value = RINGER[mode];
  if (value === undefined) throw new Error(`mode de sonnerie inconnu : ${mode}`);
  const out = await shellOut(serial, `settings put global mode_ringer ${value}`, { timeout: 8000 });
  if (!out.ok || REFUS.test(out.stdout + out.stderr)) throw new Error('le mode de sonnerie a été refusé par l\'appareil');
  return mode;
}

/// Ne pas déranger. `cmd notification set_dnd` existe depuis Android 8 ;
/// « priority » laisse passer les favoris, c'est le compromis le plus utile.
async function dndState(serial) {
  const out = await shellOut(serial, 'settings get global zen_mode', { timeout: 8000 });
  if (!out.ok) return null;
  const raw = out.stdout.trim();
  // « null » = réglage absent : on ne sait pas, plutôt que « activé ».
  if (!raw || raw === 'null') return null;
  return raw !== '0';
}

async function setDnd(serial, on) {
  const out = await shellOut(serial, `cmd notification set_dnd ${on ? 'priority' : 'off'}`, { timeout: 8000 });
  if (!out.ok || REFUS.test(out.stdout + out.stderr)) throw new Error('Ne pas déranger a été refusé par l\'appareil');
  return on;
}

/// Radio Wi-Fi, Bluetooth ou données mobiles. `svc` agit comme le panneau de
/// réglages : le shell adb porte les mêmes permissions qu'un utilisateur système.
async function setRadio(serial, radio, on) {
  const known = { wifi: true, bluetooth: true, data: true };
  if (!known[radio]) throw new Error(`radio inconnue : ${radio}`);
  const out = await shellOut(serial, `svc ${radio} ${on ? 'enable' : 'disable'}`, { timeout: 10000 });
  // `svc` sort en 0 même quand il refuse ; sa plainte part sur la sortie
  // d'erreur (« Killed », « Security exception »…), qu'il faut donc lire.
  if (!out.ok || REFUS.test(out.stdout + out.stderr)) {
    throw new Error(`la radio ${radio} a été refusée par l'appareil`);
  }
  return on;
}

// ── Pont bureau → téléphone ─────────────────────────────────────────────────
//
// Le presse-papiers manque volontairement à l'appel : `cmd clipboard` n'est pas
// implémenté sur ces appareils, et depuis Android 10 seul le programme au
// premier plan peut lire le presse-papiers. Rien de fiable à en tirer par ADB ;
// scrcpy le synchronise déjà pour ses propres fenêtres.

/// Là où atterrit ce qu'on envoie : le dossier que l'utilisateur connaît.
const DOSSIER_TELEPHONE = '/sdcard/Download';

/// Rend un fichier visible dans « Mes fichiers » et la galerie.
///
/// Sans cela, le fichier est bien sur la carte mais l'index média l'ignore :
/// il n'apparaît nulle part, et l'utilisateur croit l'envoi perdu. L'ancien
/// broadcast MEDIA_SCANNER_SCAN_FILE ne fait plus rien pour une application
/// ordinaire ; `content call … scan_file` est la voie qui reste.
async function scanMedia(serial, remote) {
  await shellOut(
    serial,
    `content call --uri content://media/external --method scan_file --arg ${quote(remote)}`,
    { timeout: 15000 }
  );
}

/// Un nom de fichier acceptable pour la carte du téléphone.
///
/// Le nom vient d'un fichier déposé à la souris : il peut contenir n'importe
/// quoi, y compris des barres obliques une fois traversé un lien symbolique.
/// On ne garde que le nom de base, et les caractères que VFAT refuse sont
/// remplacés plutôt que de faire échouer l'envoi sans explication.
function remoteName(local) {
  const base = path.basename(String(local)).replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '');
  return base || `fichier-${Date.now()}`;
}

/// Envoie un fichier dans le dossier Téléchargements du téléphone.
///
/// `adb push` n'affiche sa progression que sur un terminal : branché sur un
/// tube, il ne dit rien avant la ligne finale. La progression est donc mesurée
/// à la source — la taille du fichier tel qu'il grossit sur le téléphone.
async function pushFile(serial, local, { onProgress } = {}) {
  const taille = fs.statSync(local).size;
  const distant = `${DOSSIER_TELEPHONE}/${remoteName(local)}`;

  let sonde = null;
  if (onProgress && taille > 512 * 1024) {
    sonde = setInterval(async () => {
      const out = await shellOut(serial, `stat -c %s ${quote(distant)} 2>/dev/null`, { timeout: 5000 });
      const envoyé = Number(String(out.stdout || '').trim());
      if (Number.isFinite(envoyé) && envoyé > 0) onProgress({ sent: Math.min(envoyé, taille), total: taille });
    }, 700);
  }

  // Pas de délai maximal : un gros fichier sur un câble lent prend le temps
  // qu'il prend, et une coupure arbitraire laisserait un fichier tronqué.
  const out = await run(findAdb(), adbArgs(serial, ['push', local, distant]), { timeout: 0 });
  if (sonde) clearInterval(sonde);

  const texte = out.stdout + out.stderr;
  if (!out.ok || /adb: error|failed to copy/i.test(texte)) {
    throw new Error(expliqueTransfert(texte) || "l'envoi a échoué");
  }
  await scanMedia(serial, distant).catch(() => {});
  if (onProgress) onProgress({ sent: taille, total: taille });
  return { remote: distant, bytes: taille };
}

/// Installe une application depuis un fichier .apk.
///
/// `-r` : remplacer une version déjà présente en gardant ses données. Sans
/// cela, réinstaller une application connue échoue sur ALREADY_EXISTS, ce qui
/// n'apprend rien à personne.
async function installApk(serial, local) {
  const out = await run(findAdb(), adbArgs(serial, ['install', '-r', local]), { timeout: 0 });
  const texte = out.stdout + out.stderr;
  if (!out.ok || !/^Success/m.test(texte)) {
    throw new Error(expliqueTransfert(texte) || "l'installation a échoué");
  }
  return true;
}

/// Traduit les plaintes d'adb et du gestionnaire de paquets.
const CAUSES_TRANSFERT = [
  [/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i,
   'une version signée différemment est déjà installée. Désinstallez-la d\'abord sur le téléphone.'],
  [/INSTALL_FAILED_VERSION_DOWNGRADE/i,
   'la version installée sur le téléphone est plus récente que ce fichier.'],
  [/INSTALL_FAILED_INSUFFICIENT_STORAGE|No space left/i,
   "le téléphone n'a plus assez d'espace libre."],
  [/INSTALL_PARSE_FAILED|not a valid apk|Invalid file|doesn't end \.apk/i,
   "ce fichier n'est pas une application Android valide."],
  [/INSTALL_FAILED_USER_RESTRICTED|user restricted/i,
   "le téléphone refuse les installations par USB. Autorisez « Installer via USB » dans les options de développement."],
  [/Permission denied|Read-only file system/i,
   "le téléphone a refusé l'écriture dans ce dossier."],
  [/device unauthorized|not authorized/i,
   "le téléphone n'a pas autorisé cet ordinateur. Acceptez la demande de débogage USB."],
  [/device not found|device offline/i,
   'le téléphone a été perdu en cours de route. Vérifiez le câble.'],
];

function expliqueTransfert(texte) {
  for (const [motif, cause] of CAUSES_TRANSFERT) if (motif.test(texte)) return cause;
  // À défaut, la plainte brute d'adb vaut mieux que rien.
  const ligne = texte.split('\n').find((l) => /error|failure|failed/i.test(l));
  return ligne ? ligne.replace(/^adb:\s*(error:\s*)?/i, '').trim() : null;
}

/// Les schémas d'adresse qu'on accepte d'ouvrir sur le téléphone.
///
/// La liste est close : `am start -a VIEW` sur une adresse `file://` ou
/// `content://` choisie ailleurs ferait ouvrir au téléphone un contenu qu'il
/// n'a pas demandé.
const SCHEMES = /^(https?|tel|mailto|sms|smsto|geo|market):/i;

/// Ouvre un lien sur le téléphone, dans l'application qui en a la charge.
async function openUrl(serial, url) {
  const adresse = String(url || '').trim();
  if (!SCHEMES.test(adresse)) throw new Error('adresse non prise en charge');
  if (/[\s]/.test(adresse)) throw new Error('adresse invalide');
  const out = await shellTry(
    serial,
    `am start --user ${OWNER_USER} -a android.intent.action.VIEW -d ${quote(adresse)}`,
    { timeout: 15000 }
  );
  const texte = out.stdout + out.stderr;
  if (!out.ok || /Error|Exception/.test(texte)) {
    throw new Error(/no activity found/i.test(texte)
      ? "aucune application du téléphone ne sait ouvrir ce lien"
      : "le téléphone a refusé d'ouvrir ce lien");
  }
  return adresse;
}

// ── Réseaux Wi-Fi ───────────────────────────────────────────────────────────
//
// Ce que le shell ADB peut faire sans root, vérifié sur Android 13 :
//
//   lire       `cmd wifi status`, `list-scan-results`, `list-networks`  → oui
//   oublier    `cmd wifi forget-network <id>`                           → oui
//   suggérer   `cmd wifi add-suggestion …`                              → oui
//   connecter  `cmd wifi connect-network` / `add-network`               → NON
//
// Les deux dernières lèvent « Uid 2000 does not have access ». Rejoindre un
// réseau depuis l'ordinateur passe donc forcément par une suggestion, que le
// téléphone fait valider d'une tape — Android ne laisse pas une machine
// branchée en USB choisir seule le réseau du téléphone, et c'est heureux.

/// Une ligne de `cmd wifi list-scan-results`.
///
///     BSSID              Frequency  RSSI        Age(sec)  SSID    Flags
///     1e:dd:32:27:23:82  2412       -90(0:-90)  80,695    Chez X  [WPA2-PSK-CCMP][ESS]
///
/// Le SSID peut contenir des espaces — et même des crochets : « Chez Jean
/// [maison] » est un nom de réseau parfaitement légal. Les drapeaux, eux, sont
/// toujours accolés les uns aux autres en fin de ligne ; c'est cette suite
/// sans espace qui sert de borne, et non le premier crochet venu.
function parseScanLine(line) {
  const m = /^\s*([0-9a-f]{2}(?::[0-9a-f]{2}){5})\s+(\d+)\s+(-?\d+)\([^)]*\)\s+\S+\s+(.*?)\s*((?:\[[^\]]*\])+)\s*$/i.exec(line);
  if (!m) return null;
  const flags = m[5];
  return {
    bssid: m[1],
    frequency: Number(m[2]),
    // 2,4 GHz et 5 GHz : la bande dit plus que la fréquence à l'utilisateur.
    band: Number(m[2]) >= 5000 ? '5 GHz' : '2,4 GHz',
    rssi: Number(m[3]),
    ssid: m[4],
    flags,
    security: securityOf(flags),
    // Un réseau qui ne diffuse pas son nom n'apparaît que par son BSSID.
    hidden: !m[4],
  };
}

/// Le type de sécurité, dans le vocabulaire d'`add-suggestion`.
function securityOf(flags) {
  if (/SAE/.test(flags)) return 'wpa3';
  if (/PSK/.test(flags)) return 'wpa2';
  if (/OWE/.test(flags)) return 'owe';
  if (/EAP/.test(flags)) return 'eap'; // hors de portée d'une suggestion shell
  return 'open';
}

/// Barreaux d'antenne, de 0 à 4, à partir du RSSI en dBm.
function signalBars(rssi) {
  if (rssi >= -55) return 4;
  if (rssi >= -66) return 3;
  if (rssi >= -77) return 2;
  if (rssi >= -88) return 1;
  return 0;
}

async function wifiScan(serial, { rescan = true } = {}) {
  if (rescan) await shellOut(serial, 'cmd wifi start-scan', { timeout: 8000 });
  const out = await shellOut(serial, 'cmd wifi list-scan-results', { timeout: 15000 });
  if (!out.ok) return [];

  // Un même réseau est vu par plusieurs bornes : on garde la mieux reçue.
  const meilleurs = new Map();
  for (const line of out.stdout.split('\n')) {
    const point = parseScanLine(line);
    if (!point) continue;
    const clé = point.ssid || point.bssid;
    const connu = meilleurs.get(clé);
    if (!connu || point.rssi > connu.rssi) meilleurs.set(clé, point);
  }
  return [...meilleurs.values()]
    .map((r) => ({ ...r, bars: signalBars(r.rssi) }))
    .sort((a, b) => b.rssi - a.rssi);
}

/// Les réseaux enregistrés sur le téléphone.
///
/// La commande liste une ligne par type de sécurité accepté : le même réseau
/// revient deux fois (wpa2-psk puis wpa3-sae). On dédoublonne par identifiant.
async function wifiSaved(serial) {
  const out = await shellOut(serial, 'cmd wifi list-networks', { timeout: 10000 });
  if (!out.ok) return [];
  const réseaux = new Map();
  for (const line of out.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(.*?)\s{2,}(\S+)\s*$/.exec(line);
    if (!m || m[2] === 'SSID') continue;
    const id = Number(m[1]);
    if (!réseaux.has(id)) réseaux.set(id, { id, ssid: m[2].trim(), security: m[3].replace(/\^$/, '') });
  }
  return [...réseaux.values()];
}

/// L'état de la connexion : allumée ? associée ? à quoi ?
async function wifiStatus(serial) {
  const out = await shellOut(serial, 'cmd wifi status', { timeout: 10000 });
  if (!out.ok) return null;
  const texte = out.stdout;
  const connecté = /Wifi is connected to "?([^"\n]+)"?/i.exec(texte);
  const ssid = /\bSSID:\s*"([^"]+)"/.exec(texte);
  return {
    enabled: /Wifi is enabled/i.test(texte),
    connected: Boolean(connecté || ssid),
    ssid: (connecté ? connecté[1] : ssid ? ssid[1] : '').trim() || null,
  };
}

/// Oublier un réseau enregistré.
async function wifiForget(serial, networkId) {
  const id = Number(networkId);
  if (!Number.isInteger(id) || id < 0) throw new Error('identifiant de réseau invalide');
  const out = await shellOut(serial, `cmd wifi forget-network ${id}`, { timeout: 10000 });
  const texte = out.stdout + out.stderr;
  if (!out.ok || REFUS.test(texte) || /Forget failed/i.test(texte)) {
    throw new Error("le téléphone a refusé d'oublier ce réseau");
  }
  return true;
}

const SECURITES = new Set(['open', 'owe', 'wpa2', 'wpa3']);

/// Proposer un réseau au téléphone.
///
/// C'est le seul chemin ouvert sans root : la suggestion est déposée, et
/// Android demande à l'utilisateur, **sur le téléphone**, s'il accepte de s'y
/// connecter (drapeau `-s`). Sans cette tape, rien ne se passe : une machine
/// branchée en USB ne choisit pas le réseau du téléphone.
///
/// Le mot de passe traverse le shell de l'appareil : il apparaît le temps d'un
/// battement dans la liste des processus du téléphone. C'est inévitable par
/// cette voie — raison de plus pour ne jamais l'écrire dans le journal.
async function wifiSuggest(serial, { ssid, security = 'wpa2', passphrase = '', hidden = false }) {
  const nom = String(ssid || '').trim();
  if (!nom) throw new Error('nom de réseau vide');
  if (!SECURITES.has(security)) throw new Error(`sécurité non prise en charge : ${security}`);
  const avecClé = security === 'wpa2' || security === 'wpa3';
  if (avecClé && !passphrase) throw new Error('ce réseau demande un mot de passe');
  if (avecClé && (passphrase.length < 8 || passphrase.length > 63)) {
    throw new Error('un mot de passe Wi-Fi compte entre 8 et 63 caractères');
  }

  // Une suggestion homonyme prendrait la place de l'ancienne sans prévenir :
  // on retire d'abord, pour repartir d'un état connu.
  await shellOut(serial, `cmd wifi remove-suggestion ${quote(nom)}`, { timeout: 8000 });

  const morceaux = ['cmd wifi add-suggestion', quote(nom), security];
  if (avecClé) morceaux.push(quote(passphrase));
  morceaux.push('-s'); // soumettre à l'utilisateur du téléphone
  if (hidden) morceaux.push('-h');
  const out = await shellOut(serial, morceaux.join(' '), { timeout: 15000 });
  const texte = out.stdout + out.stderr;
  if (!out.ok || REFUS.test(texte)) {
    throw new Error(texte.split('\n').find((l) => /Exception|error/i.test(l))?.trim() || 'la suggestion a été refusée par le téléphone');
  }
  return { ssid: nom, security, hidden };
}

/// Les suggestions déposées par Aura, pour pouvoir les retirer.
async function wifiSuggestions(serial) {
  const out = await shellOut(serial, 'cmd wifi list-suggestions', { timeout: 10000 });
  if (!out.ok) return [];
  return out.stdout
    .split('\n')
    .map((l) => /^\s*(.*?)\s{2,}(\S+)\s*$/.exec(l))
    .filter((m) => m && m[1] && m[1] !== 'SSID')
    .map((m) => ({ ssid: m[1].trim(), security: m[2].replace(/\^$/, '') }));
}

async function wifiUnsuggest(serial, ssid) {
  const out = await shellOut(serial, `cmd wifi remove-suggestion ${quote(String(ssid))}`, { timeout: 10000 });
  return out.ok;
}

/// Ouvre les réglages Wi-Fi sur le téléphone.
///
/// La voie de secours quand la suggestion ne suffit pas — réseau d'entreprise,
/// portail captif, mot de passe à changer. Avec le miroir ouvert, le clavier de
/// l'ordinateur tape directement dans le champ du téléphone.
async function openWifiSettings(serial) {
  const out = await shellTry(
    serial,
    `am start --user ${OWNER_USER} -a android.settings.WIFI_SETTINGS`,
    { timeout: 10000 }
  );
  return out.ok && !/Error|Exception/.test(out.stdout + out.stderr);
}

// ── Inventaire des applications ─────────────────────────────────────────────

// Format de `scrcpy --list-apps` : un préfixe (* système, - utilisateur), le
// libellé, un remplissage d'espaces, puis le paquet. Le libellé peut contenir
// des espaces, le paquet jamais : on coupe au dernier champ.
function parseAppLine(line) {
  let rest = null;
  let system = false;
  if (line.startsWith(' * ')) { rest = line.slice(3); system = true; }
  else if (line.startsWith(' - ')) { rest = line.slice(3); }
  if (rest === null) return null;

  const trimmed = rest.replace(/\s+$/, '');
  const cut = trimmed.lastIndexOf(' ');
  if (cut < 0) return null;
  const name = trimmed.slice(0, cut).trim();
  const pkg = trimmed.slice(cut + 1).trim();
  if (!name || !pkg || !pkg.includes('.')) return null;
  return { name, package: pkg, system };
}

async function listApps(serial) {
  const engine = await findEngine();
  const args = serial ? ['--serial', serial, '--list-apps'] : ['--list-apps'];
  // L'opération est lente : scrcpy pousse son serveur puis interroge le
  // gestionnaire de paquets (~20 s pour 150 applications).
  const out = await run(engine.path, args, { timeout: 120000 });

  const apps = [];
  const seen = new Set();
  for (const line of (out.stdout + '\n' + out.stderr).split('\n')) {
    const app = parseAppLine(line);
    if (app && !seen.has(app.package)) {
      seen.add(app.package);
      apps.push(app);
    }
  }
  if (!apps.length) {
    throw new Error(
      'aucune application détectée. Vérifiez que le téléphone est déverrouillé et ' +
        "que le débogage USB est autorisé pour cet ordinateur."
    );
  }
  apps.sort((a, b) => (a.system === b.system ? a.name.localeCompare(b.name, 'fr') : a.system ? 1 : -1));
  return apps;
}

// ── Ouverture d'une fenêtre d'application ───────────────────────────────────

function sessionArgs(serial, app, settings) {
  const args = [];
  if (serial) args.push('--serial', serial);

  // Le miroir recopie l'écran existant : ni écran virtuel, ni application à
  // démarrer, et la fenêtre se contente de mettre l'image à l'échelle.
  if (settings.mirror) {
    if (settings.windowWidth) args.push(`--window-width=${Math.round(settings.windowWidth)}`);
    else if (settings.windowHeight) args.push(`--window-height=${Math.round(settings.windowHeight)}`);
    args.push(`--video-codec=${settings.codec}`);
    if (settings.bitrate) args.push(`--video-bit-rate=${settings.bitrate}`);
    if (settings.maxFps) args.push(`--max-fps=${settings.maxFps}`);
    if (!settings.audio) args.push('--no-audio');
    args.push(`--window-title=${app.name}`);
    return args;
  }

  args.push(`--new-display=${settings.width}x${settings.height}/${settings.dpi}`);
  args.push(`--start-app=${app.package}`);
  if (settings.flex) args.push('--flex-display');
  // Taille d'ouverture de la fenêtre. scrcpy refuse ces options avec
  // `--flex-display` : dans ce cas c'est la définition qui a déjà été réduite.
  else if (settings.windowWidth) args.push(`--window-width=${Math.round(settings.windowWidth)}`);
  else if (settings.windowHeight) args.push(`--window-height=${Math.round(settings.windowHeight)}`);
  if (settings.keepActive) args.push('--keep-active');
  if (settings.noSystemDecorations) args.push('--no-vd-system-decorations');
  // Verrouille la rotation captée. Sans cela, une application qui impose son
  // orientation fait tourner l'écran virtuel, ce qui redimensionne la fenêtre,
  // ce qui — avec le suivi de fenêtre — refait tourner l'écran : la bascule ne
  // s'arrête plus.
  if (settings.captureOrientation) args.push(`--capture-orientation=${settings.captureOrientation}`);
  args.push(`--video-codec=${settings.codec}`);
  if (settings.bitrate) args.push(`--video-bit-rate=${settings.bitrate}`);
  if (settings.maxFps) args.push(`--max-fps=${settings.maxFps}`);
  if (!settings.audio) args.push('--no-audio');
  args.push(`--window-title=${app.name}`);
  return args;
}

// `[server] INFO: New display: 1280x800/160 (id=38)`
function parseDisplayId(line) {
  const m = /\(id=(\d+)\)/.exec(line);
  return m ? Number(m[1]) : null;
}

/// Le signe qu'une fenêtre est bien à l'écran, en miroir.
///
/// Le miroir ne crée pas d'écran virtuel : il n'y a donc pas de `(id=…)` à
/// attendre, et guetter celui-ci revenait à déclarer perdu un lancement qui
/// marchait — le chien de garde tuait la fenêtre au bout de 45 secondes.
/// scrcpy annonce en revanche son moteur de rendu et sa texture au moment où
/// la fenêtre s'ouvre ; le libellé varie selon les versions, d'où l'alternative.
const MIRROR_READY = /INFO:\s*(?:Renderer|Initial texture|Texture|Device screen|Display)\b/i;

/// Délai au bout duquel un miroir encore vivant est tenu pour affiché.
///
/// Ces annonces n'arrivent pas forcément à temps : branchée sur un tube, la
/// sortie standard de scrcpy est mise en mémoire tampon par blocs et ne part
/// qu'une fois pleine — parfois à la fermeture. Seuls les messages du serveur
/// (`[server] …`) et les erreurs, écrites sur la sortie d'erreur, arrivent
/// tout de suite. C'est pourquoi les fenêtres d'application, qui attendent une
/// ligne du serveur, ont toujours marché là où le miroir ne remontait rien.
///
/// Un scrcpy toujours vivant quelques secondes après le lancement, et muet
/// d'erreurs, a donc ouvert sa fenêtre : rester à l'écouter n'apprendrait rien.
const MIRROR_GRACE = 6000;

/// Les options longues que ce binaire scrcpy connaît réellement.
///
/// Les distributions livrent des versions très variables : une 3.3.4 passe le
/// seuil 3.0 exigé par les écrans virtuels, mais ignore des options plus
/// récentes (--flex-display, --keep-active…) et meurt sur "unrecognized
/// option" sans rien afficher. Plutôt que de maintenir une table de versions,
/// on lit la sortie de --help : toute option absente est retirée de la ligne
/// de commande, la fonctionnalité correspondante simplement inactive.
let optionCache = null;
async function supportedOptions(engine) {
  if (optionCache && optionCache.path === engine.path) return optionCache.options;
  const out = await run(engine.path, ['--help'], { timeout: 8000 });
  const text = out.stdout + '\n' + out.stderr;
  const options = new Set();
  for (const m of text.matchAll(/(^|\s)--([a-z0-9-]+)/g)) options.add(`--${m[2]}`);
  optionCache = { path: engine.path, options };
  return options;
}

/// Retire les options que ce scrcpy ne connaît pas, et signale chacune.
function filterArgs(args, supported, notes) {
  const kept = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { kept.push(arg); continue; }
    const name = arg.split('=')[0];
    if (supported.has(name)) { kept.push(arg); continue; }
    notes.push(`${name} ignoré : non reconnu par cette version de scrcpy.`);
    // Une option à valeur séparée (`--serial XYZ`) emporte son argument.
    if (!arg.includes('=') && i + 1 < args.length && !args[i + 1].startsWith('--')) i++;
  }
  return kept;
}

/// Délai au-delà duquel un lancement qui n'a rien affiché est considéré perdu.
const START_TIMEOUT = 45000;

/// Traduit la sortie de scrcpy en cause probable, en français.
///
/// Un échec de lancement est presque toujours muet côté interface : le
/// processus meurt en une seconde et l'utilisateur ne voit qu'une fenêtre qui
/// ne vient pas. Les messages ci-dessous couvrent les échecs rencontrés sur le
/// terrain ; les autres sont remontés bruts, ce qui vaut toujours mieux que le
/// silence.
const CAUSES = [
  [/Could not create display|createVirtualDisplay|--new-display/i,
   "l'appareil a refusé de créer un écran virtuel. Les écrans virtuels demandent Android 11 ou plus récent ; certaines surcouches les bloquent aussi tant que l'écran est verrouillé."],
  [/device unauthorized|not authorized/i,
   "le téléphone n'a pas autorisé cet ordinateur. Déverrouillez-le et acceptez la demande de débogage USB (elle est propre à chaque machine)."],
  // « Could not find ADB device X » parle du téléphone, pas du binaire adb :
  // il doit passer avant la règle sur adb introuvable, qui l'attrapait.
  [/Could not find ADB device|device not found|no devices\/emulators|device offline/i,
   'le téléphone a été perdu en cours de route. Vérifiez le câble et le mode de connexion USB.'],
  [/adb: failed|could not find adb|Failed to execute adb/i,
   "adb n'a pas pu être lancé. Installez le moteur depuis les réglages d'Aura, il fournit sa propre copie d'adb."],
  [/Could not initialize SDL|No available video device|x11 not available|Failed to open display/i,
   "scrcpy n'a pas pu ouvrir de fenêtre : aucun serveur graphique joignable. Sous Wayland, installez la couche Xwayland ; en session distante, exportez DISPLAY."],
  [/error while loading shared libraries|symbol lookup error|GLIBC_/i,
   'le binaire scrcpy est incompatible avec les bibliothèques du système. Installez le moteur depuis les réglages d\'Aura plutôt que celui de la distribution.'],
  [/Could not open video stream|Failed to start video|codec/i,
   "le flux vidéo n'a pas démarré. Essayez un autre codec dans les réglages (h264 est le plus compatible)."],
  [/Activity not started|does not exist|Unable to resolve/i,
   "l'application n'a pas pu être démarrée sur l'appareil. Elle est peut-être désinstallée ou réservée à un autre profil."],
];

function explain(text) {
  for (const [pattern, cause] of CAUSES) if (pattern.test(text)) return cause;
  return null;
}

/// Les dernières lignes utiles de la sortie de scrcpy.
function tail(log, count = 12) {
  return log.filter((l) => l.trim()).slice(-count);
}

let nextSessionId = 1;

/// Tue les serveurs scrcpy restés sur l'appareil après un lancement avorté.
///
/// Quand un client meurt sans prévenir (watchdog, plantage), le processus
/// serveur côté téléphone peut survivre et bloquer les lancements suivants :
/// scrcpy pousse son serveur, affiche « Device: … », puis attend indéfiniment
/// une fenêtre qui ne viendra jamais. Purge best-effort : si l'appareil est
/// déjà parti, il n'y a plus rien à nettoyer.
///
/// Le balayage est **collectif** : rien dans la table des processus du téléphone
/// ne relie un serveur au client qui l'a poussé — l'identifiant de session
/// (`scid`) est tiré au hasard par scrcpy et n'est pas exposé. C'est pourquoi
/// l'appelant décide : purger pendant qu'une autre fenêtre est ouverte
/// refermerait celle qui marchait, et un échec de lancement emportait jusqu'ici
/// toutes les fenêtres vivantes — y compris celles d'une autre application qui
/// se sert du même téléphone.
function purgeStaleServer(serial) {
  if (!serial) return;
  shellTry(serial, 'pkill -f com.genymobile.scrcpy', { timeout: 5000 }).catch(() => {});
}

// Chaque application est un processus scrcpy autonome, sur son propre écran
// virtuel. La fenêtre appartient au gestionnaire de fenêtres : rien n'est
// reparenté, et une application qui tombe n'emporte pas les autres.
function launchApp(serial, app, settings, hooks = {}) {
  return new Promise(async (resolve, reject) => {
    let engine;
    let args;
    let notes = [];
    try {
      engine = await findEngine();
      const supported = await supportedOptions(engine);
      args = filterArgs(sessionArgs(serial, app, settings), supported, notes);
    } catch (err) {
      return reject(err);
    }

    const id = nextSessionId++;
    // Sous Wayland, laisser SDL choisir seul donne une fenêtre Wayland native,
    // qu'aucun outil ne sait plus lever ni réduire. Passer par XWayland rend les
    // vignettes de session opérantes (voir `session.js`).
    const pilote = session_.videoDriver({ xwayland: settings.xwayland !== false });
    let child;
    try {
      child = spawn(engine.path, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv(pilote ? { SDL_VIDEODRIVER: pilote } : null),
      });
    } catch (err) {
      return reject(err);
    }
    const session = {
      id,
      package: app.package,
      name: app.name,
      state: 'starting',
      displayId: null,
      startedAt: Date.now(),
      command: [engine.path, ...args],
      log: notes.map((n) => `[aura] ${n}`),
      child,
    };

    // Un lancement qui n'a rien affiché au bout de trois quarts de minute ne
    // s'affichera plus : scrcpy attend quelque chose qui ne viendra pas.
    // Mieux vaut le dire que laisser un processus fantôme.
    let watchdog = setTimeout(() => {
      watchdog = null;
      if (session.state !== 'starting') return;
      // Un scrcpy toujours vivant, sans la moindre erreur au journal, a selon
      // toute vraisemblance ouvert sa fenêtre : sa sortie ne dit simplement pas
      // ce que cette version-ci annonce. Le tuer serait le pire des choix — on
      // le laisse vivre et on note l'incertitude.
      const muet = child.exitCode === null && !session.log.some((l) => /\bERROR\b/.test(l));
      if (muet) {
        session.log.push('[aura] démarrage non confirmé par scrcpy — session supposée active.');
        return ready(null);
      }
      fail("aucune fenêtre au bout de 45 secondes — le lancement a été abandonné.");
      // Le client meurt, mais le serveur côté téléphone peut lui survivre et
      // faire échouer le lancement suivant en silence. On le purge.
      purge();
      try { child.kill('SIGTERM'); } catch (_) {}
    }, START_TIMEOUT);

    // Le balayage des serveurs orphelins n'est pas sélectif (voir
    // `purgeStaleServer`) : il n'a lieu que si l'appelant confirme qu'aucune
    // autre fenêtre ne serait emportée au passage.
    const purge = () => {
      if (hooks.canPurge && !hooks.canPurge()) {
        session.log.push('[aura] serveur orphelin non purgé : d\'autres fenêtres sont ouvertes.');
        return;
      }
      purgeStaleServer(serial);
    };

    let reported = false;
    const fail = (message) => {
      if (reported) return;
      reported = true;
      session.state = 'failed';
      session.error = message;
      session.hint = explain(session.log.join('\n'));
      // À défaut de cause reconnue, la propre plainte de scrcpy vaut mieux
      // qu'un code de sortie : c'est elle qu'on montrera à l'utilisateur.
      session.reason = (session.log.find((l) => /\bERROR\b/.test(l)) || '').replace(/^.*ERROR:\s*/, '').trim() || null;
      session.tail = tail(session.log);
      if (hooks.onFail) hooks.onFail(session);
    };

    const ready = (displayId, { presumed = false } = {}) => {
      if (session.state === 'running') return;
      session.state = 'running';
      session.presumed = presumed;
      if (displayId !== null) session.displayId = displayId;
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      if (grace) { clearTimeout(grace); grace = null; }
      if (hooks.onUpdate) hooks.onUpdate(session);
    };

    // Le miroir n'a pas de ligne de serveur à attendre : c'est le fait de
    // tenir debout, sans erreur, qui fait foi.
    let grace = settings.mirror
      ? setTimeout(() => {
          grace = null;
          if (session.state !== 'starting') return;
          if (child.exitCode !== null || session.log.some((l) => /\bERROR\b/.test(l))) return;
          ready(null, { presumed: true });
        }, MIRROR_GRACE)
      : null;

    const onLine = (line) => {
      if (!line.trim()) return;
      session.log.push(line);
      if (session.log.length > 120) session.log.shift();
      const displayId = parseDisplayId(line);
      if (displayId !== null) return ready(displayId);
      if (settings.mirror && MIRROR_READY.test(line)) ready(null);
    };

    let acc = { out: '', err: '' };
    const pump = (stream, key) => {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        acc[key] += chunk;
        const lines = acc[key].split('\n');
        acc[key] = lines.pop();
        lines.forEach(onLine);
      });
    };
    pump(child.stdout, 'out');
    pump(child.stderr, 'err');

    child.on('error', (err) => {
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      reject(err);
    });
    child.on('exit', (code) => {
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      if (grace) { clearTimeout(grace); grace = null; }
      session.exitCode = code;
      // Une session seulement *supposée* affichée qui meurt aussitôt sur un
      // code d'erreur n'a jamais rien montré : c'est un échec, et la sortie
      // retenue en tampon est justement arrivée à la fermeture.
      if (session.presumed && code && Date.now() - session.startedAt < START_TIMEOUT) {
        fail(`scrcpy s'est arrêté (code ${code}) sans ouvrir de fenêtre.`);
        purge();
        if (hooks.onUpdate) hooks.onUpdate(session);
        return;
      }
      // Sortir avant d'avoir affiché quoi que ce soit, c'est un échec — pas
      // une fermeture. La différence compte : dans un cas on prévient, dans
      // l'autre on retire simplement la vignette.
      if (session.state === 'starting') {
        fail(`scrcpy s'est arrêté (code ${code}) sans ouvrir de fenêtre.`);
      } else {
        session.state = 'stopped';
      }
      if (hooks.onUpdate) hooks.onUpdate(session);
    });

    resolve(session);
  });
}

// ── Miroir de l'écran principal ─────────────────────────────────────────────

/// Ouvre l'écran réel du téléphone, tel quel.
///
/// Tout ce qui est **système** refuse un écran virtuel : l'écran d'appel
/// entrant, le volet de notifications, l'assistant, les réglages Android.
/// Ils s'affichent sur l'écran par défaut, et le seul moyen de les voir depuis
/// l'ordinateur est de le recopier.
function mirror(serial, settings, hooks = {}) {
  return launchApp(serial, { package: null, name: 'Téléphone' }, { ...settings, mirror: true }, hooks);
}

// ── Appels ──────────────────────────────────────────────────────────────────

/// L'état des appels en cours, lu dans le gestionnaire de télécommunications.
///
/// `dumpsys telecom` pèse 170 ko et contient tout l'historique ; le filtre
/// s'applique donc **sur l'appareil**, et seules les lignes du gestionnaire
/// d'appels vivants remontent — celles de l'historique portent un horodatage
/// en tête et sont écartées par l'ancrage en début de ligne.
///
/// Le numéro, lui, est masqué par Android dans cette sortie. C'est la
/// notification de l'appel qui donne le nom de l'appelant.
async function callState(serial) {
  // Par le shell maintenu ouvert : ce sondage passe toutes les trois secondes
  // tant que le widget est visible, et un `adb shell` jetable coûterait ici
  // dix fois le prix de la commande elle-même.
  const out = await shellOut(
    serial,
    `dumpsys telecom | awk '/^[[:space:]]*\\[Call id=/{print}'`,
    { timeout: 8000 }
  ).catch(() => null);
  if (!out || !out.ok) return null;

  const appels = [];
  for (const line of out.stdout.split('\n')) {
    const id = /\[Call id=([^,]+)/.exec(line);
    const state = /state=([A-Z_]+)/.exec(line);
    if (!id || !state) continue;
    appels.push({ id: id[1], state: state[1] });
  }
  if (!appels.length) return null;

  // Un appel qui sonne prime sur tout le reste : c'est le seul qui demande une
  // décision immédiate.
  const ordre = ['RINGING', 'DIALING', 'CONNECTING', 'ACTIVE', 'ON_HOLD'];
  for (const state of ordre) {
    const trouve = appels.find((a) => a.state === state);
    if (trouve) return trouve;
  }
  return null;
}

/// Décrocher.
///
/// `KEYCODE_HEADSETHOOK` plutôt que `KEYCODE_CALL` : c'est la touche des
/// kits mains-libres, celle qu'Android accepte encore d'une source externe sur
/// les versions récentes.
async function answerCall(serial) {
  const out = await shellTry(serial, 'input keyevent 79', { timeout: 8000 });
  return out.ok;
}

/// Raccrocher, ou refuser un appel qui sonne.
async function hangUpCall(serial) {
  const out = await shellTry(serial, 'input keyevent 6', { timeout: 8000 });
  return out.ok;
}

/// Le composeur par défaut de l'appareil.
///
/// Codé en dur, ce serait `com.samsung.android.dialer` chez l'un et
/// `com.google.android.dialer` chez l'autre. Android sait répondre lui-même à
/// la question : on la lui pose.
async function defaultDialer(serial) {
  // `--user ${OWNER_USER}` : voir la règle 1 en tête de fichier. Sans elle, un
  // téléphone dont un profil secondaire est au premier plan — Secure Folder,
  // Dual Messenger — répond pour ce profil-là.
  const out = await shellTry(
    serial,
    `cmd package resolve-activity --brief --user ${OWNER_USER} -a android.intent.action.DIAL`,
    { timeout: 10000 }
  );
  const ligne = out.stdout.trim().split('\n').pop().trim() || '';
  const pkg = ligne.split('/')[0].trim();
  return PACKAGE.test(pkg) ? pkg : null;
}

/// Ouvre le composeur avec un numéro pré-rempli.
///
/// `ACTION_DIAL` et non `ACTION_CALL` : le numéro s'affiche, et c'est
/// l'utilisateur qui appuie sur le bouton vert. Un numéro mal tapé part trop
/// vite autrement.
async function dial(serial, number, displayId = null) {
  const propre = String(number).replace(/[^0-9+*#,;]/g, '');
  if (!propre) throw new Error('numéro vide');
  const cible = displayId === null ? '' : `--display ${Number(displayId)} `;
  const out = await shellTry(
    serial,
    `am start --user ${OWNER_USER} ${cible}-a android.intent.action.DIAL -d ${quote(`tel:${propre}`)}`,
    { timeout: 10000 }
  );
  return { ok: out.ok && !/Error|Exception/.test(out.stdout + out.stderr), number: propre };
}

// ── Notifications ───────────────────────────────────────────────────────────

// `dumpsys notification --noredact` décrit chaque notification affichée. On ne
// retient que ce qui se montre : paquet, titre, texte, horodatage.
function parseNotifications(dump) {
  const items = [];
  const blocks = dump.split(/NotificationRecord\(/).slice(1);
  for (const block of blocks) {
    const pkg = /pkg=([\w.]+)/.exec(block);
    if (!pkg) continue;
    // Les blocs suivants commencent après ; on borne la lecture au premier
    // bloc pour ne pas récolter les extras du voisin.
    const scope = block.split('\n    NotificationRecord')[0];
    const title = /android\.title=String \(([\s\S]*?)\)\n/.exec(scope);
    const titleBig = /android\.title\.big=String \(([\s\S]*?)\)\n/.exec(scope);
    const text = /android\.text=String \(([\s\S]*?)\)\n/.exec(scope);
    const when = /^\s+when=(\d+)/m.exec(scope);
    // Android range les notifications par catégorie : `call` pour un appel en
    // cours, `msg` pour un message. C'est ce qui permet de traiter un appel
    // autrement qu'une mise à jour d'application.
    const category = /category=(\w+)/.exec(scope);
    // La clé se lit sur sa propre ligne : celle de l'en-tête du bloc traîne un
    // « : » final et servirait mal à désigner la notification.
    const key = /^\s+key=([^\s]+)\s*$/m.exec(scope);
    const clean = (m) => (m ? m[1].replace(/\s+/g, ' ').trim() : '');
    const t = clean(title) || clean(titleBig);
    const b = clean(text);
    if (!t && !b) continue;
    items.push({
      key: key ? key[1] : `${pkg[1]}-${items.length}`,
      package: pkg[1],
      title: t,
      text: b,
      when: when ? Number(when[1]) : null,
      category: category ? category[1] : null,
    });
  }
  // Les plus récentes d'abord ; celles sans horodatage ferment la marche.
  items.sort((a, b) => (b.when || 0) - (a.when || 0));
  return items;
}

// Les clés seules, pour savoir si quelque chose a changé.
//
// Le dump complet pèse plus d'un mégaoctet et coûte 0,3 s ; cette liste tient
// en deux cents octets et répond en 0,05 s. Le sondage régulier passe par ici,
// et ne réclame le dump que lorsque l'ensemble a bougé.
async function listNotificationKeys(serial) {
  const out = await shellTry(serial, 'cmd notification list', { timeout: 8000 });
  if (!out.ok) return [];
  return out.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('|'));
}

async function listNotifications(serial) {
  const dump = await shell(serial, 'dumpsys notification --noredact', { timeout: 20000 });
  return parseNotifications(dump);
}

// Écarte une notification.
//
// Android n'expose aucune commande « dismiss » par ADB : `cmd notification` ne
// connaît que `snooze`. Une mise en sommeil de vingt-quatre heures la retire du
// volet aussi sûrement qu'un balayage, sans toucher à l'application qui l'a
// posée.
const SNOOZE_MS = 24 * 60 * 60 * 1000;

async function dismissNotification(serial, key) {
  const out = await shellTry(serial, `cmd notification snooze --for ${SNOOZE_MS} ${quote(key)}`, { timeout: 10000 });
  return out.ok && /snoozing/i.test(out.stdout + out.stderr);
}

async function dismissAll(serial, keys) {
  let done = 0;
  for (const key of keys) {
    if (await dismissNotification(serial, key)) done++;
  }
  return done;
}

// Réveille l'écran et ouvre le volet des notifications sur le téléphone.
async function expandNotificationShade(serial) {
  await shell(serial, 'cmd statusbar expand-notifications', { timeout: 8000 });
}

/// Un état des lieux lisible, à joindre à un signalement.
///
/// Tout ce qui peut différer d'une machine à l'autre — et donc expliquer
/// qu'Aura marche ici et pas là — tient dans ces quelques lignes.
async function diagnostics(serial) {
  const report = {
    aura: null,
    platform: `${process.platform}/${process.arch}`,
    session: process.env.XDG_SESSION_TYPE || (process.env.WAYLAND_DISPLAY ? 'wayland' : process.env.DISPLAY ? 'x11' : 'inconnue'),
    display: process.env.DISPLAY || process.env.WAYLAND_DISPLAY || '(aucun)',
    desktop: process.env.XDG_CURRENT_DESKTOP || '(inconnu)',
    appimage: Boolean(process.env.APPDIR),
    engine: null,
    engineError: null,
    adb: null,
    device: null,
  };

  try {
    const engine = await findEngine();
    report.engine = `${engine.version.release} — ${engine.path}`;
  } catch (err) {
    report.engineError = err.message;
  }

  const adbOut = await run(findAdb(), ['version'], { timeout: 8000 });
  report.adb = adbOut.ok ? `${(adbOut.stdout.split('\n')[0] || '').trim()} — ${findAdb()}` : `introuvable (${findAdb()})`;

  if (serial) {
    const sdk = (await shell(serial, `getprop ro.build.version.sdk`, { timeout: 8000 })).trim();
    const release = (await shell(serial, `getprop ro.build.version.release`, { timeout: 8000 })).trim();
    const model = (await shell(serial, `getprop ro.product.model`, { timeout: 8000 })).trim();
    report.device = `${model || serial} — Android ${release || '?'} (API ${sdk || '?'})`;
    // Les écrans virtuels demandent Android 11 (API 30).
    if (sdk && Number(sdk) < 30) {
      report.deviceWarning = `Android ${release} ne sait pas créer d'écran virtuel : Aura demande Android 11 ou plus récent.`;
    }
  }
  return report;
}

module.exports = {
  mirror,
  defaultDialer,
  callState,
  answerCall,
  hangUpCall,
  dial,
  diagnostics,
  explain,
  childEnv,
  OWNER_USER,
  findEngine,
  resetEngine,
  findAdb,
  startServer,
  listDevices,
  deviceInfo,
  connectivity,
  pressKey,
  mediaVolume,
  changeMediaVolume,
  ringerMode,
  setRingerMode,
  dndState,
  setDnd,
  setRadio,
  pushFile,
  installApk,
  openUrl,
  scanMedia,
  remoteName,
  expliqueTransfert,
  DOSSIER_TELEPHONE,
  wifiScan,
  wifiSaved,
  wifiStatus,
  wifiForget,
  wifiSuggest,
  wifiSuggestions,
  wifiUnsuggest,
  openWifiSettings,
  parseScanLine,
  signalBars,
  listApps,
  launchApp,
  listNotifications,
  listNotificationKeys,
  dismissNotification,
  quote,
  assertPackage,
  dismissAll,
  expandNotificationShade,
  parseAppLine,
  parseNotifications,
  parseVersion,
  parseDisplayId,
  sessionArgs,
  filterArgs,
  supportedOptions,
  adb,
  shell,
  shellOut,
  shellTry,
  pshell,
  closeShell,
};
