'use strict';
// De quelle sorte de session graphique s'agit-il ?
//
// La question n'est pas théorique. Aura pilote les fenêtres des autres — celles
// de scrcpy — et c'est le protocole graphique qui décide si c'est possible :
//
//   X11      `wmctrl` lève une fenêtre, `xdotool` la réduit. Tout marche.
//   Wayland  Aucun protocole standard ne permet à une application d'en lever
//            une autre. C'est un choix de conception du protocole, pas un
//            oubli : une fenêtre ne peut pas s'imposer devant les autres.
//
// Entre les deux vit **XWayland**, le serveur X de compatibilité que toute
// session Wayland fait tourner. Une fenêtre qui passe par lui reste une fenêtre
// X11 : `wmctrl` la voit, et tout le pilotage existant fonctionne à nouveau.
//
// C'est la porte de sortie d'Aura, parce que scrcpy sait emprunter l'une ou
// l'autre : son SDL embarque les deux pilotes et obéit à `SDL_VIDEODRIVER`.
// Laissé libre, SDL 2.0.22 et suivants choisissent Wayland — et les vignettes
// de session cessent alors de fonctionner, sans rien dire.
//
// Rien ici ne lit l'environnement du processus directement : tout passe par un
// paramètre, pour que ce soit vérifiable sans changer de session.

/// Le type de session, d'après l'environnement.
///
/// `XDG_SESSION_TYPE` fait foi quand il est renseigné ; sinon on se rabat sur
/// la présence des variables d'affichage, qui ne mentent pas non plus.
function sessionType(env = process.env) {
  const annoncé = String(env.XDG_SESSION_TYPE || '').toLowerCase();
  if (annoncé === 'wayland' || annoncé === 'x11') return annoncé;
  if (env.WAYLAND_DISPLAY) return 'wayland';
  if (env.DISPLAY) return 'x11';
  return 'inconnue';
}

/// Le pilote vidéo à imposer à scrcpy, ou `null` pour le laisser choisir.
///
/// Sous Wayland, le forcer en X11 le fait passer par XWayland : l'image perd un
/// peu en netteté quand l'écran est à une échelle fractionnaire (125 %, 150 %),
/// mais les fenêtres redeviennent pilotables — cliquer sur une vignette ramène
/// la fenêtre, ce qui est la raison d'être de ces vignettes.
///
/// Le compromis se règle, et se court-circuite par `AURA_SDL_VIDEODRIVER` pour
/// qui veut trancher sans passer par l'interface.
function videoDriver({ env = process.env, xwayland = true } = {}) {
  const forcé = env.AURA_SDL_VIDEODRIVER;
  if (forcé) return forcé;
  if (!xwayland) return null;
  return sessionType(env) === 'wayland' ? 'x11' : null;
}

/// Le pilotage des fenêtres est-il envisageable, et sinon pourquoi ?
///
/// Répondu sans lancer le moindre outil : c'est la question préalable, celle
/// qui dit s'il vaut la peine d'aller chercher `wmctrl`.
function windowControl({ platform = process.platform, env = process.env, xwayland = true } = {}) {
  if (platform !== 'linux') {
    return { possible: false, raison: `le pilotage des fenêtres n'est disponible que sous Linux/X11 (système : ${platform})` };
  }
  const type = sessionType(env);
  if (type === 'x11') return { possible: true, via: 'x11' };
  if (type === 'wayland') {
    // Les fenêtres de scrcpy passent par XWayland : elles restent des fenêtres
    // X11, donc pilotables. Encore faut-il qu'un serveur X soit joignable.
    if (xwayland && env.DISPLAY) return { possible: true, via: 'xwayland' };
    return {
      possible: false,
      raison: xwayland
        ? "session Wayland sans XWayland joignable (DISPLAY absent) : les fenêtres d'application ne peuvent pas être pilotées"
        : "session Wayland : aucun protocole ne permet de lever la fenêtre d'une autre application. Activez « Fenêtres pilotables sous Wayland » dans les réglages",
    };
  }
  return { possible: false, raison: `session graphique inconnue : ni DISPLAY ni WAYLAND_DISPLAY` };
}

/// La photographie du bureau est-elle praticable sans importuner ?
///
/// Sous Wayland, `desktopCapturer` passe par le portail xdg-desktop-portal, qui
/// demande à l'utilisateur de désigner un écran — à **chaque** capture. Le fond
/// flouté se prend à chaque apparition du widget : ce serait une boîte de
/// dialogue par appui sur le raccourci. On s'en abstient plutôt que d'infliger
/// cela, et l'interface l'explique au lieu de laisser croire à une panne.
function wallpaperCapture({ env = process.env } = {}) {
  if (sessionType(env) === 'wayland') {
    return { possible: false, raison: 'sous Wayland, photographier l’écran demande une autorisation à chaque prise' };
  }
  return { possible: true };
}

module.exports = { sessionType, videoDriver, windowControl, wallpaperCapture };
