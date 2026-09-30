'use strict';
// Géométrie des fenêtres d'application.
//
// Rien ici ne touche à Electron, à l'appareil ni à l'écran : ce module reçoit
// des nombres et en rend d'autres. C'est délibéré — cette arithmétique est la
// plus délicate du projet (deux façons de rétrécir une fenêtre, qui ne donnent
// pas du tout le même résultat) et la seule qu'on puisse vérifier entièrement
// sans téléphone, sans serveur graphique et sans scrcpy.

/// Ramène la fenêtre d'application à une fraction de l'écran, par le chemin
/// que scrcpy autorise.
///
/// Il y a deux façons de faire une petite fenêtre, et elles ne donnent pas du
/// tout le même résultat :
///
///   - **Réduire l'image.** L'écran virtuel garde sa définition et sa densité,
///     et scrcpy met la vidéo à l'échelle. La mise en page Android est
///     exactement celle du téléphone, en plus petit. C'est ce qu'on veut, et
///     c'est le plus net.
///   - **Réduire l'écran virtuel.** Android relaie une surface plus petite. À
///     densité constante, il y voit un très petit téléphone et dessine tout en
///     énorme : une fenêtre de 360 px à 320 ppp ne fait que 180 dp de large.
///     Il faut donc réduire la densité dans la même proportion, sans quoi le
///     contenu grossit au lieu de rétrécir.
///
/// La première demande `--window-width`/`--window-height`, que scrcpy refuse
/// quand `--flex-display` est actif — puisque c'est alors la fenêtre qui
/// commande la définition. On prend donc l'un ou l'autre selon le réglage.
function sizing(settings, aire) {
  const part = Math.min(1, Math.max(0.25, Number(settings.windowScale) || 0.55));
  const { width: sw, height: sh } = aire;
  const width = settings.width || 1280;
  const height = settings.height || 800;
  const tenir = Math.min(1, (sw * part) / width, (sh * part) / height);

  if (!settings.flex) {
    if (tenir >= 1) return {};
    // Une seule dimension : scrcpy déduit l'autre et garde le rapport, ce qui
    // évite les bandes noires.
    return (sw * part) / width < (sh * part) / height
      ? { windowWidth: Math.max(280, Math.round(width * tenir)) }
      : { windowHeight: Math.max(280, Math.round(height * tenir)) };
  }

  // En dessous de 360 px sur son petit côté, une application Android n'a plus
  // de mise en page utilisable. Le plancher s'applique au facteur, pas à
  // chaque dimension : autrement la forme se déformerait aux petites tailles.
  const plancher = 360 / Math.min(width, height);
  const facteur = Math.max(plancher, tenir);
  const pair = (n) => Math.round(n / 2) * 2;

  return {
    width: pair(width * facteur),
    height: pair(height * facteur),
    // La densité suit la définition : même nombre de « dp », donc la même
    // mise en page, simplement dessinée sur moins de pixels.
    dpi: Math.max(72, Math.round((settings.dpi || 160) * facteur)),
  };
}

module.exports = { sizing };
