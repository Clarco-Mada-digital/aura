'use strict';
// Ce qui est au premier plan, écran par écran.
//
// Une fenêtre Aura, c'est une application sur son propre écran virtuel. Mais une
// application n'est pas une île : le composeur propose d'envoyer un message, une
// pièce jointe veut s'ouvrir « avec », un appel demande par quelle carte SIM
// partir. Android décide alors seul de l'écran où poser la suite, et ses
// décisions ne vont pas toutes dans notre sens :
//
//   - Une activité lancée par une autre **hérite** normalement de l'écran de
//     celle qui l'appelle : le message s'ouvre bien dans la fenêtre du
//     composeur. Sauf si l'application visée tourne déjà ailleurs, ou si elle se
//     déclare `singleTask`/`singleInstance` — alors la tâche existante reprend
//     la main, sur l'écran où elle vit déjà : l'écran principal du téléphone.
//   - Les boîtes du **système** — choix de carte SIM, « ouvrir avec », demande
//     de permission — ne s'affichent jamais sur un écran virtuel. Elles
//     appartiennent à l'écran par défaut, quoi qu'on demande.
//
// Dans les deux cas, l'utilisateur voit son geste ne mener à rien : la fenêtre
// qu'il attend n'apparaît pas, et la validation qu'on lui demande est sur un
// écran qu'il ne regarde pas. Rien ne permet de forcer Android à faire
// autrement — `am display move-stack` a disparu, et aucune commande du shell ne
// déplace une tâche d'un écran à l'autre depuis Android 11.
//
// Ce qui reste est de le **voir** et d'y répondre : ouvrir le miroir quand une
// validation attend, ouvrir une vraie fenêtre Aura quand c'est une application
// qui a surgi. C'est l'objet de ce module.

const device = require('./device');

/// L'écran par défaut du téléphone : celui de sa dalle.
const ECRAN_PRINCIPAL = 0;

/// Ce qui, dans la sortie de `dumpsys`, désigne un couple paquet/activité.
///
///     mCurrentFocus=Window{9f3a2 u0 com.android.dialer/com.android.dialer.Main}
///     mFocusedApp=ActivityRecord{1b2c u0 com.android.dialer/.DialtactsActivity t42}
///
/// L'identifiant de profil (`u0`) sert d'ancre : sans lui, le `/` d'un chemin
/// quelconque suffirait à faire croire à une activité.
const CIBLE = /\bu\d+\s+([A-Za-z0-9_][A-Za-z0-9_.]*)\/([A-Za-z0-9_.$]+)/;

/// Les étiquettes derrière lesquelles se cache « ce qui est devant ».
///
/// Le libellé change d'une version d'Android à l'autre, et d'une commande à
/// l'autre. Plutôt que d'entretenir une table de versions, on accepte les
/// variantes connues et on garde la première qui réponde pour un écran donné —
/// elles sont rangées du plus au moins précis par `dumpsys` lui-même.
const DEVANT = /\b(?:mCurrentFocus|mFocusedApp|topResumedActivity|mResumedActivity|ResumedActivity)\s*[=:]/;

/// Le début d'une section d'écran, dans l'une ou l'autre des deux commandes.
///
///     Display: mDisplayId=0              (dumpsys window displays)
///     Display #38 (activities from top to bottom):   (dumpsys activity activities)
const ECRAN = /(?:mDisplayId=|Display\s+#)(\d+)/;

/// Ce qui est au premier plan sur chaque écran, d'après une sortie filtrée.
///
/// Retourne une table `{ [displayId]: { package, activity } }`. Un écran sans
/// rien de reconnaissable n'y figure pas — mieux vaut ne rien savoir que croire
/// savoir.
function parseForeground(text) {
  const ecrans = {};
  let courant = null;

  for (const ligne of String(text || '').split('\n')) {
    const entete = ECRAN.exec(ligne);
    // Une même ligne peut porter l'écran *et* sa cible (« Display #0 … »), mais
    // jamais l'inverse : on lit donc l'en-tête d'abord, sans passer à la suite.
    if (entete && !DEVANT.test(ligne)) {
      courant = Number(entete[1]);
      continue;
    }
    if (courant === null || !DEVANT.test(ligne)) continue;
    // Le premier verdict d'un écran est le bon : les suivants décrivent des
    // tâches enfouies sous celle qui est devant.
    if (ecrans[courant]) continue;

    const cible = CIBLE.exec(ligne);
    if (!cible) continue;
    ecrans[courant] = { package: cible[1], activity: cible[2] };
  }
  return ecrans;
}

/// Paquets dont tout ce qui s'affiche est une boîte du système.
const PAQUETS_SYSTEME = new Set([
  'android',
  'com.android.systemui',
  'com.android.permissioncontroller',
  'com.google.android.permissioncontroller',
  'com.android.server.telecom',
  'com.android.intentresolver',
]);

/// Noms d'activité qui annoncent une demande, non une application.
///
/// Le choix de carte SIM est `SelectPhoneAccountActivity`, « ouvrir avec » est
/// `ResolverActivity` ou `ChooserActivity`, une permission est `GrantPermissions`.
/// Tous se terminent par un mot de cette famille.
const ACTIVITES_BOITE =
  /(?:Resolver|Chooser|Dialog|Picker|Confirm|Permission|Grant|Warning|Select[A-Za-z]*Account|Alert)/i;

/// Est-ce une boîte qui attend une réponse, plutôt qu'une application ?
///
/// La distinction commande la réaction : une boîte se **montre** (par le
/// miroir, puisqu'elle refuse les écrans virtuels), une application
/// s'**ouvre** (dans sa propre fenêtre).
function estBoite(devant) {
  if (!devant) return false;
  if (PAQUETS_SYSTEME.has(devant.package)) return true;
  return ACTIVITES_BOITE.test(devant.activity);
}

/// Les deux commandes, de la plus économe à la plus complète.
///
/// `dumpsys window displays` pèse quelques kilo-octets et donne l'écran avec sa
/// fenêtre active : c'est exactement ce qu'on cherche. `dumpsys activity
/// activities` est bien plus lourd, mais il répond encore là où la première a
/// changé de forme. Le filtre s'applique **sur l'appareil** dans les deux cas :
/// seules les quelques lignes utiles traversent le câble.
const SONDES = [
  `dumpsys window displays | grep -E 'mDisplayId=|mCurrentFocus=|mFocusedApp='`,
  `dumpsys activity activities | grep -E 'Display #[0-9]+|ResumedActivity'`,
];

/// Ce qui est devant, sur chaque écran du téléphone.
async function foreground(serial) {
  if (!serial) return null;
  for (const sonde of SONDES) {
    const out = await device.shellTry(serial, sonde, { timeout: 6000 });
    if (!out.ok) continue;
    const ecrans = parseForeground(out.stdout);
    // L'écran principal a toujours quelque chose devant lui, ne serait-ce que
    // l'écran d'accueil. Une table sans lui trahit une sortie qu'on n'a pas su
    // lire, et c'est le signe qu'il faut essayer l'autre commande.
    if (Object.keys(ecrans).length && ECRAN_PRINCIPAL in ecrans) return ecrans;
  }
  return null;
}

/// Le paquet de l'écran d'accueil, demandé à Android plutôt que devinée.
///
/// Sans lui, revenir à l'accueil ressemblerait à « une application a surgi » et
/// Aura proposerait d'ouvrir le lanceur du téléphone dans une fenêtre.
async function homePackage(serial) {
  // `--user 0`, comme partout ailleurs : un téléphone peut faire tourner
  // plusieurs profils en même temps — Secure Folder, Dual Messenger, Island —
  // et `cmd package` sans profil explicite répond pour celui du premier plan.
  // Vérifié sur un Galaxy A71 : quatre profils actifs, dont trois qui ne
  // regardent pas Aura.
  const out = await device.shellTry(
    serial,
    `cmd package resolve-activity --brief --user ${device.OWNER_USER} -a android.intent.action.MAIN -c android.intent.category.HOME`,
    { timeout: 8000 }
  );
  const ligne = (out.stdout || '').trim().split('\n').pop().trim();
  const pkg = ligne.split('/')[0].trim();
  return /^[A-Za-z0-9_](?:[A-Za-z0-9_.]*[A-Za-z0-9_])?$/.test(pkg) ? pkg : null;
}

module.exports = {
  ECRAN_PRINCIPAL,
  parseForeground,
  estBoite,
  foreground,
  homePackage,
  PAQUETS_SYSTEME,
};
