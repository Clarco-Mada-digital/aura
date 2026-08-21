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
      { maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout || 30000, encoding: opts.encoding || 'utf8', env: childEnv() },
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
function childEnv() {
  const env = { ...process.env };
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

async function shell(serial, command, opts) {
  const out = await adb(serial, ['shell', command], opts);
  return out.ok ? out.stdout : '';
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
  [/device not found|no devices\/emulators|device offline/i,
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

// Chaque application est un processus scrcpy autonome, sur son propre écran
// virtuel. La fenêtre appartient au gestionnaire de fenêtres : rien n'est
// reparenté, et une application qui tombe n'emporte pas les autres.
function launchApp(serial, app, settings, hooks = {}) {
  return new Promise(async (resolve, reject) => {
    let engine;
    try {
      engine = await findEngine();
    } catch (err) {
      return reject(err);
    }

    const id = nextSessionId++;
    const args = sessionArgs(serial, app, settings);
    let child;
    try {
      child = spawn(engine.path, args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() });
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
      log: [],
      child,
    };

    // Un lancement qui n'a rien affiché au bout de trois quarts de minute ne
    // s'affichera plus : scrcpy attend quelque chose qui ne viendra pas.
    // Mieux vaut le dire que laisser un processus fantôme.
    let watchdog = setTimeout(() => {
      watchdog = null;
      if (session.state !== 'starting') return;
      fail("aucune fenêtre au bout de 45 secondes — le lancement a été abandonné.");
      try { child.kill('SIGTERM'); } catch (_) {}
    }, START_TIMEOUT);

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

    const onLine = (line) => {
      if (!line.trim()) return;
      session.log.push(line);
      if (session.log.length > 120) session.log.shift();
      const displayId = parseDisplayId(line);
      if (displayId !== null && session.state !== 'running') {
        session.state = 'running';
        session.displayId = displayId;
        if (watchdog) { clearTimeout(watchdog); watchdog = null; }
        if (hooks.onUpdate) hooks.onUpdate(session);
      }
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
      session.exitCode = code;
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
  const out = await adb(serial, ['shell', 'cmd notification list'], { timeout: 8000 });
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
  const out = await adb(serial, ['shell', `cmd notification snooze --for ${SNOOZE_MS} ${quote(key)}`], { timeout: 10000 });
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
  sessionArgs,
  adb,
  shell,
};
