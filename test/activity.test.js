'use strict';
// Le guet des applications liées.
//
// Ce qu'on peut vérifier ici sans téléphone : la lecture de la sortie de
// `dumpsys` et le tri entre « une boîte attend une réponse » et « une
// application a surgi ». C'est là que sont les pièges — le format change d'une
// version d'Android à l'autre, et se tromper de catégorie fait ouvrir une
// fenêtre pour un choix de carte SIM, ou l'inverse.

const test = require('node:test');
const assert = require('node:assert');

const activity = require('../src/activity');

// ── Lecture de « ce qui est devant » ────────────────────────────────────────

// `dumpsys window displays`, filtré sur l'appareil. Forme rencontrée
// d'Android 11 à 15 : une section par écran, l'écran virtuel de scrcpy compris.
const FENETRES = `  Display: mDisplayId=0
    mCurrentFocus=Window{9f3a2b1 u0 com.android.dialer/com.android.dialer.DialtactsActivity}
    mFocusedApp=ActivityRecord{1b2c3d4 u0 com.android.dialer/.DialtactsActivity t42}
  Display: mDisplayId=38
    mCurrentFocus=Window{7e8f9a0 u0 com.whatsapp/com.whatsapp.HomeActivity}
    mFocusedApp=ActivityRecord{5a6b7c8 u0 com.whatsapp/.HomeActivity t51}
`;

test('parseForeground lit un écran et son application, section par section', () => {
  const ecrans = activity.parseForeground(FENETRES);
  assert.deepStrictEqual(ecrans[0], {
    package: 'com.android.dialer',
    activity: 'com.android.dialer.DialtactsActivity',
  });
  assert.deepStrictEqual(ecrans[38], {
    package: 'com.whatsapp',
    activity: 'com.whatsapp.HomeActivity',
  });
});

test('parseForeground garde le premier verdict d’un écran, pas le dernier', () => {
  // `mFocusedApp` décrit la même chose que `mCurrentFocus` juste au-dessus : la
  // seconde ligne ne doit pas écraser la première, sinon un écran dont la
  // fenêtre active et l'activité active divergent donnerait la mauvaise.
  const ecrans = activity.parseForeground(FENETRES);
  assert.strictEqual(ecrans[0].activity, 'com.android.dialer.DialtactsActivity');
});

// `dumpsys activity activities`, l'autre forme — celle du repli.
const ACTIVITES = `Display #0 (activities from top to bottom):
    mResumedActivity: ActivityRecord{aa11bb u0 com.android.settings/.Settings t7}
Display #12 (activities from top to bottom):
    mResumedActivity: ActivityRecord{cc22dd u0 org.videolan.vlc/.StartActivity t19}
`;

test('parseForeground accepte aussi la forme « Display #N » de dumpsys activity', () => {
  const ecrans = activity.parseForeground(ACTIVITES);
  assert.strictEqual(ecrans[0].package, 'com.android.settings');
  assert.strictEqual(ecrans[12].package, 'org.videolan.vlc');
});

test('parseForeground ignore les fenêtres sans activité nommée', () => {
  // La barre d'état est une fenêtre sans couple paquet/activité : la prendre
  // pour une application ferait proposer d'ouvrir « StatusBar » dans un cadre.
  const ecrans = activity.parseForeground(
    `  Display: mDisplayId=0\n    mCurrentFocus=Window{1234 u0 StatusBar}\n`
  );
  assert.deepStrictEqual(ecrans, {});
});

test('parseForeground ne s’égare pas hors d’une section d’écran', () => {
  // Une ligne utile avant tout en-tête n'appartient à aucun écran connu :
  // l'attribuer à l'écran 0 par défaut serait une invention.
  const ecrans = activity.parseForeground(
    `mCurrentFocus=Window{1 u0 com.foo/.Bar}\n  Display: mDisplayId=0\n`
  );
  assert.deepStrictEqual(ecrans, {});
});

test('parseForeground survit à du vide et à du bruit', () => {
  for (const entrée of ['', null, undefined, 'n’importe quoi\nsur deux lignes']) {
    assert.deepStrictEqual(activity.parseForeground(entrée), {});
  }
});

// ── Boîte du système, ou application ? ──────────────────────────────────────

test('estBoite reconnaît le choix de carte SIM', () => {
  // Le cas qui a motivé tout ceci : appuyer sur « Appeler » avec deux cartes
  // SIM ouvre ce sélecteur sur la dalle du téléphone, et nulle part ailleurs.
  assert.ok(activity.estBoite({
    package: 'com.android.server.telecom',
    activity: '.components.SelectPhoneAccountActivity',
  }));
});

test('estBoite reconnaît « ouvrir avec » et les demandes de permission', () => {
  assert.ok(activity.estBoite({ package: 'android', activity: '.ResolverActivity' }));
  assert.ok(activity.estBoite({ package: 'com.android.intentresolver', activity: '.ChooserActivity' }));
  assert.ok(activity.estBoite({
    package: 'com.google.android.permissioncontroller',
    activity: '.permission.ui.GrantPermissionsActivity',
  }));
});

test('estBoite laisse passer une vraie application', () => {
  // C'est ce cas-là qui mérite une fenêtre Aura, et lui seul.
  assert.strictEqual(activity.estBoite({ package: 'com.whatsapp', activity: '.HomeActivity' }), false);
  assert.strictEqual(
    activity.estBoite({ package: 'com.google.android.apps.messaging', activity: '.ui.ConversationListActivity' }),
    false
  );
  assert.strictEqual(activity.estBoite(null), false);
});

test('estBoite ne se fie pas au seul mot « Dialog » dans un nom de paquet', () => {
  // Le tri porte sur l'activité et sur une liste close de paquets système :
  // une application qui s'appellerait « com.dialogue.chat » reste une
  // application.
  assert.strictEqual(activity.estBoite({ package: 'com.dialogue.chat', activity: '.MainActivity' }), false);
});
