'use strict';
// Installation du moteur vidéo (scrcpy) depuis l'application.
//
// Beaucoup de distributions livrent encore scrcpy 1.25, qui ne connaît pas les
// écrans virtuels ; d'autres ne livrent rien du tout. Envoyer l'utilisateur
// chercher une archive sur GitHub à ce moment-là, c'est le perdre. Aura sait
// donc récupérer la version officielle lui-même — et l'archive Linux embarque
// aussi `adb`, ce qui règle les deux dépendances d'un coup.
//
// L'empreinte est vérifiée, pas seulement supposée : elle est comparée à celle
// publiée dans le `SHA256SUMS.txt` de la version, recopiée ici. Un
// téléchargement altéré est effacé plutôt qu'exécuté.

const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

/// Version épinglée, avec son empreinte officielle.
const RELEASE = {
  version: '4.1',
  archives: {
    'linux-x64': {
      file: 'scrcpy-linux-x86_64-v4.1.tar.gz',
      folder: 'scrcpy-linux-x86_64-v4.1',
      sha256: 'ad56ae8bfeedf41e824945c11dbf55fcb092b3e615b9b486f48a50e30d389635',
      bytes: 17762813,
    },
    'win32-x64': {
      file: 'scrcpy-win64-v4.1.zip',
      folder: 'scrcpy-win64-v4.1',
      sha256: '5b12172b3264b2889f4583ee64752ce832e29bc8b1089dca81093459697165db',
      bytes: 11305298,
    },
    'win32-ia32': {
      file: 'scrcpy-win32-v4.1.zip',
      folder: 'scrcpy-win32-v4.1',
      sha256: 'fa57b36622a53b6aec74c5e5b5c08236165efa445c4f186d48f176ebf9c24eec',
      bytes: 10191501,
    },
    'darwin-arm64': {
      file: 'scrcpy-macos-aarch64-v4.1.tar.gz',
      folder: 'scrcpy-macos-aarch64-v4.1',
      sha256: '20fd47c9014dd5e0fa77091f3cb7adbda8445a360c4584aeaa0150b5b3988ff3',
      bytes: 12981888,
    },
    'darwin-x64': {
      file: 'scrcpy-macos-x86_64-v4.1.tar.gz',
      folder: 'scrcpy-macos-x86_64-v4.1',
      sha256: 'ee2a7223bc8dbdc4f482db1134bcf441178dafb833492b71ca4c22090c58ce72',
      bytes: 13904869,
    },
  },
};

const WINDOWS = process.platform === 'win32';
const EXE = WINDOWS ? '.exe' : '';

const BASE = 'https://github.com/Genymobile/scrcpy/releases/download';

/// Le dossier de données du système, là où chacun range ce genre de chose.
function dataDir() {
  if (WINDOWS) {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'aura');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'aura');
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'aura');
}

function engineDir() {
  return path.join(dataDir(), 'engine');
}

/// La combinaison système/architecture, si une archive existe pour elle.
///
/// Le projet scrcpy publie pour Linux x86_64, Windows 32/64 bits et macOS
/// (Intel comme Apple Silicon) — les trois archives embarquent leur propre
/// `adb`. Il ne publie rien pour Linux ARM : sur ces machines il faut passer
/// par la distribution ou compiler, et l'interface le dit au lieu de proposer
/// un bouton qui ne mènerait nulle part.
function target() {
  const key = `${process.platform}-${process.arch}`;
  return RELEASE.archives[key] ? key : null;
}

function download(url, destination, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('trop de redirections'));

    https
      .get(url, { headers: { 'User-Agent': 'Aura' } }, (response) => {
        const { statusCode, headers } = response;

        // GitHub redirige vers son stockage d'objets : il faut suivre.
        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          response.resume();
          return resolve(download(headers.location, destination, onProgress, redirects + 1));
        }
        if (statusCode !== 200) {
          response.resume();
          return reject(new Error(`le serveur a répondu ${statusCode}`));
        }

        const total = Number(headers['content-length']) || 0;
        let received = 0;
        const hash = crypto.createHash('sha256');
        const file = fs.createWriteStream(destination);

        response.on('data', (chunk) => {
          received += chunk.length;
          hash.update(chunk);
          if (onProgress) onProgress({ received, total });
        });
        response.pipe(file);

        file.on('finish', () => file.close(() => resolve(hash.digest('hex'))));
        file.on('error', reject);
        response.on('error', reject);
      })
      .on('error', (err) =>
        reject(
          new Error(
            /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT/.test(err.code || '')
              ? 'impossible de joindre github.com : vérifiez la connexion réseau'
              : err.message
          )
        )
      );
  });
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 120000 }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve(stdout)
    );
  });
}

/// Ouvre l'archive, quel que soit son format.
///
/// `tar` sait lire les archives zip depuis qu'il s'appuie sur bsdtar, ce qui
/// est le cas de celui livré avec Windows 10 et suivants. Sur une machine plus
/// ancienne, PowerShell prend le relais : pas de dépendance à installer dans
/// un cas comme dans l'autre.
async function extract(archivePath, destination) {
  try {
    await run('tar', ['-xf', archivePath, '-C', destination]);
    return;
  } catch (err) {
    if (!WINDOWS || !archivePath.endsWith('.zip')) throw err;
  }
  await run('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destination}' -Force`,
  ]);
}

/// Récupère, vérifie et installe scrcpy. Retourne le chemin du binaire.
async function install(onProgress = () => {}) {
  const key = target();
  if (!key) {
    throw new Error(
      `aucune archive officielle de scrcpy pour ${process.platform}/${process.arch}. ` +
        'Installez scrcpy 3.0 ou plus récent par votre gestionnaire de paquets.'
    );
  }

  const archive = RELEASE.archives[key];
  const url = `${BASE}/v${RELEASE.version}/${archive.file}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-engine-'));
  const tarball = path.join(work, archive.file);

  try {
    onProgress({ phase: 'download', received: 0, total: archive.bytes });
    const digest = await download(url, tarball, ({ received, total }) =>
      onProgress({ phase: 'download', received, total: total || archive.bytes })
    );

    onProgress({ phase: 'verify' });
    if (digest !== archive.sha256) {
      throw new Error(
        'empreinte inattendue — le téléchargement a été altéré, il est effacé ' +
          `(attendu ${archive.sha256.slice(0, 12)}…, obtenu ${digest.slice(0, 12)}…)`
      );
    }

    onProgress({ phase: 'extract' });
    await extract(tarball, work);

    const extracted = path.join(work, archive.folder);
    if (!fs.existsSync(path.join(extracted, `scrcpy${EXE}`))) {
      throw new Error('archive inattendue : le binaire scrcpy est introuvable');
    }

    const destination = engineDir();
    fs.mkdirSync(destination, { recursive: true });
    fs.cpSync(extracted, destination, { recursive: true, force: true });

    // L'archive porte les droits d'exécution, mais une copie peut les perdre
    // selon le système de fichiers.
    for (const binary of [`scrcpy${EXE}`, `adb${EXE}`]) {
      const file = path.join(destination, binary);
      if (fs.existsSync(file)) fs.chmodSync(file, 0o755);
    }

    onProgress({ phase: 'done' });
    return path.join(destination, `scrcpy${EXE}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { install, target, engineDir, dataDir, RELEASE };
