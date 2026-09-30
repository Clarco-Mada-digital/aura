'use strict';
// Loger une fenêtre d'application dans le bureau d'Aura.
//
// Le mode bureau fait ce que le reste d'Aura se refuse à faire : il **reparente**
// les fenêtres de scrcpy dans la sienne. Il faut savoir ce que cela coûte, parce
// que ce n'est pas un détail d'implémentation.
//
// Une fenêtre reparentée sort de la juridiction du gestionnaire de fenêtres. Il
// ne la décore plus, ne la déplace plus, ne la fait plus apparaître dans Alt+Tab
// ni dans la barre des tâches. Tout ce qu'il faisait pour elle, le bureau doit
// désormais le faire lui-même : barre de titre, déplacement, redimensionnement,
// ordre d'empilement, réduction. C'est un gestionnaire de fenêtres en miniature,
// et c'est le prix d'un bureau qui contient vraiment ses fenêtres plutôt que de
// les laisser flotter au-dessus.
//
// Cela ne marche que sous X11 — XWayland compris, ce qui couvre aussi les
// sessions Wayland tant que les fenêtres y transitent (voir `session.js`). Là où
// c'est impossible, le bureau ne s'effondre pas : il renonce à loger les
// fenêtres, qui flottent alors par-dessus lui comme sur un bureau ordinaire.
//
// ── Pourquoi un aide en Python ──────────────────────────────────────────────
//
// `XReparentWindow` n'a pas d'équivalent en ligne de commande : `wmctrl` et
// `xdotool` savent lever et réduire, pas reparenter. python-xlib le fait, et se
// trouve déjà sur la plupart des bureaux Linux — `windows.js` s'en sert déjà
// comme solution de repli pour la réduction.
//
// L'aide est **maintenu ouvert**, pour la même raison que le shell adb l'est :
// déplacer une fenêtre à la souris envoie des dizaines d'ordres par seconde, et
// démarrer un interpréteur Python à chaque fois coûterait cent fois le prix de
// l'ordre lui-même. Un processus, une connexion X, des ordres en JSON ligne à
// ligne.

const { spawn } = require('child_process');

const log = require('./log');

/// L'aide, tel qu'il tourne sur la machine.
///
/// Chaque ligne lue est un ordre ; chaque ligne écrite est sa réponse. Les
/// erreurs X sont attrapées et renvoyées plutôt que de tuer l'aide : une fenêtre
/// peut disparaître entre le moment où on décide de la déplacer et celui où
/// l'ordre arrive, et ce n'est pas une raison pour perdre toutes les autres.
const AIDE = `
import sys, json, time
from Xlib import display, X, error

d = display.Display()
d.set_error_handler(lambda *a: None)
root = d.screen().root

def fenetre(id_):
    return d.create_resource_object('window', int(id_, 16) if isinstance(id_, str) else id_)

def executer(o):
    op = o.get('op')

    if op == 'reparent':
        # Retirer une fenetre a son gestionnaire tient en trois gestes, et
        # l'ordre compte. Observe sur Cinnamon/Muffin : reparenter directement
        # ne tient pas une seconde — le gestionnaire recoit l'evenement, reprend
        # la fenetre dans son cadre, et tout est a refaire.
        #
        #   1. La replier. Le gestionnaire voit l'UnmapNotify, la considere
        #      retiree, detruit son cadre et la rend a la racine.
        #   2. Attendre qu'il ait fini. C'est un aller-retour : agir avant que
        #      la fenetre soit revenue a la racine, c'est courir contre lui — et
        #      perdre, puisqu'il agit en dernier.
        #   3. La declarer override-redirect. Le gestionnaire cesse alors de la
        #      considerer : plus de cadre, plus de placement impose, plus de
        #      reprise au prochain map. C'est ce que font les menus deroulants
        #      et les infobulles, pour la meme raison.
        enfant, parent = fenetre(o['child']), fenetre(o['parent'])

        enfant.unmap()
        d.sync()

        # Le gestionnaire rend la fenetre a la racine ; on lui laisse le temps.
        for _ in range(60):
            try:
                if enfant.query_tree().parent.id == root.id:
                    break
            except Exception:
                break
            time.sleep(0.02)

        enfant.change_attributes(override_redirect=True)
        d.sync()

        enfant.reparent(parent, int(o['x']), int(o['y']))
        enfant.configure(width=int(o['w']), height=int(o['h']))
        enfant.map()
        enfant.configure(stack_mode=X.Above)
        d.sync()

        # On verifie plutot que d'esperer : le reparentage est exactement le
        # genre d'ordre qu'un gestionnaire peut defaire dans notre dos.
        try:
            reel = enfant.query_tree().parent.id
        except Exception:
            return {'ok': False, 'error': 'fenetre disparue pendant le reparentage'}
        if reel != parent.id:
            return {'ok': False, 'error': 'le gestionnaire de fenetres a repris la fenetre (parent %s)' % hex(reel)}
        return {'ok': True}

    if op == 'configure':
        f = fenetre(o['child'])
        args = {}
        for cle in ('x', 'y'):
            if cle in o: args[cle] = int(o[cle])
        if 'w' in o: args['width'] = max(1, int(o['w']))
        if 'h' in o: args['height'] = max(1, int(o['h']))
        f.configure(**args)
        d.flush()
        return {'ok': True}

    if op == 'stack':
        fenetre(o['child']).configure(stack_mode=X.Above)
        d.flush()
        return {'ok': True}

    if op == 'map':
        fenetre(o['child']).map(); d.flush(); return {'ok': True}

    if op == 'unmap':
        fenetre(o['child']).unmap(); d.flush(); return {'ok': True}

    if op == 'release':
        # Rendre la fenetre au gestionnaire : elle redevient une fenetre
        # ordinaire, decoree et rangee dans Alt+Tab. Il faut lui retirer
        # override-redirect, sans quoi le gestionnaire continuerait de l'ignorer
        # et elle resterait sans cadre, posee sur le bureau du systeme.
        f = fenetre(o['child'])
        f.unmap()
        d.sync()
        f.change_attributes(override_redirect=False)
        f.reparent(root, int(o.get('x', 100)), int(o.get('y', 100)))
        d.sync()
        f.map()
        d.sync()
        return {'ok': True}

    if op == 'alive':
        try:
            fenetre(o['child']).get_geometry()
            return {'ok': True, 'alive': True}
        except Exception:
            return {'ok': True, 'alive': False}

    if op == 'find':
        # Recherche par identifiant de processus, dans l'arbre X complet.
        #
        # wmctrl ne convient pas ici : il lit _NET_CLIENT_LIST, que le
        # gestionnaire de fenetres ne remplit que pour ce qu'il gere. Observe
        # sur un Cinnamon/Muffin : une fenetre scrcpy bien presente, decoree et
        # visible, absente de la liste. La recherche doit donc porter sur
        # l'arbre lui-meme, qui ne depend d'aucune cooperation.
        vise = int(o['pid'])
        pid_atom = d.intern_atom('_NET_WM_PID')
        trouve = []

        def descendre(w, profondeur=0):
            if profondeur > 4:
                return
            try:
                enfants = w.query_tree().children
            except Exception:
                return
            for e in enfants:
                try:
                    p = e.get_full_property(pid_atom, X.AnyPropertyType)
                    if p and p.value[0] == vise:
                        g = e.get_geometry()
                        # Les fenêtres minuscules sont des accessoires (icônes,
                        # fenêtres de groupe) : la vraie fenêtre a une taille.
                        if g.width > 120 and g.height > 120:
                            trouve.append((hex(e.id), g.width * g.height))
                except Exception:
                    pass
                descendre(e, profondeur + 1)

        descendre(root)
        if not trouve:
            return {'ok': True, 'window': None}
        trouve.sort(key=lambda t: -t[1])
        return {'ok': True, 'window': trouve[0][0]}

    if op == 'ping':
        return {'ok': True}

    return {'ok': False, 'error': 'ordre inconnu: %s' % op}

for ligne in sys.stdin:
    ligne = ligne.strip()
    if not ligne:
        continue
    try:
        ordre = json.loads(ligne)
    except Exception as e:
        print(json.dumps({'ok': False, 'error': 'json: %s' % e}), flush=True)
        continue
    try:
        reponse = executer(ordre)
    except Exception as e:
        reponse = {'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}
    reponse['id'] = ordre.get('id')
    print(json.dumps(reponse), flush=True)
`;

let aide = null;
let suite = 0;
let indisponible = null;

/// Démarre l'aide, ou rend celui qui tourne déjà.
function demarrer() {
  if (aide) return aide;

  const proc = spawn('python3', ['-c', AIDE], { stdio: ['pipe', 'pipe', 'pipe'] });
  const session = { proc, attente: new Map(), tampon: '' };
  aide = session;

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (morceau) => {
    session.tampon += morceau;
    let coupe;
    while ((coupe = session.tampon.indexOf('\n')) >= 0) {
      const ligne = session.tampon.slice(0, coupe);
      session.tampon = session.tampon.slice(coupe + 1);
      if (!ligne.trim()) continue;
      let reponse;
      try { reponse = JSON.parse(ligne); } catch (_) { continue; }
      const en = session.attente.get(reponse.id);
      if (!en) continue;
      session.attente.delete(reponse.id);
      clearTimeout(en.minuterie);
      en.resoudre(reponse);
    }
  });

  // python-xlib absent, pas de serveur X joignable : l'aide meurt au démarrage.
  // On le retient pour ne pas retenter cent fois.
  const abandon = (err) => {
    if (aide !== session) return;
    aide = null;
    if (err) indisponible = err.message;
    for (const en of session.attente.values()) {
      clearTimeout(en.minuterie);
      en.resoudre({ ok: false, error: 'aide X11 perdu' });
    }
    session.attente.clear();
  };
  proc.on('exit', () => abandon(null));
  proc.on('error', (err) => abandon(err));

  return session;
}

/// Envoie un ordre et attend la réponse.
function ordonner(ordre, delai = 3000) {
  if (indisponible) return Promise.resolve({ ok: false, error: indisponible });
  const session = demarrer();
  return new Promise((resoudre) => {
    const id = ++suite;
    session.attente.set(id, {
      resoudre,
      minuterie: setTimeout(() => {
        session.attente.delete(id);
        resoudre({ ok: false, error: 'délai dépassé' });
      }, delai),
    });
    try {
      session.proc.stdin.write(`${JSON.stringify({ ...ordre, id })}\n`);
    } catch (err) {
      session.attente.delete(id);
      resoudre({ ok: false, error: err.message });
    }
  });
}

/// L'ancrage est-il praticable sur cette machine ?
///
/// La réponse se garde : elle ne changera pas en cours de session, et la
/// question est posée à chaque ouverture de fenêtre.
let praticableCache = null;

async function praticable(verdict) {
  if (praticableCache !== null) return praticableCache;

  if (!verdict.possible) {
    praticableCache = { ok: false, raison: verdict.raison };
    return praticableCache;
  }
  const r = await ordonner({ op: 'ping' }, 5000);
  praticableCache = r.ok
    ? { ok: true }
    : { ok: false, raison: `python3-xlib est nécessaire pour loger les fenêtres dans le bureau (${r.error})` };
  if (!praticableCache.ok) log.warn(`ancrage impossible : ${praticableCache.raison}`);
  return praticableCache;
}

/// La fenêtre d'un processus, cherchée dans l'arbre X.
///
/// Attendre qu'elle apparaisse fait partie du travail : scrcpy pousse son
/// serveur, négocie le flux, puis ouvre sa fenêtre — plusieurs secondes après
/// que le processus existe.
async function attendreFenetre(pid, delai = 20000) {
  const fin = Date.now() + delai;
  for (;;) {
    const r = await ordonner({ op: 'find', pid }, 3000);
    if (r.ok && r.window) return r.window;
    if (Date.now() > fin) return null;
    await new Promise((s) => setTimeout(s, 350));
  }
}

/// Loge une fenêtre dans une autre, à la position et à la taille demandées.
const reparent = (child, parent, x, y, w, h) => ordonner({ op: 'reparent', child, parent, x, y, w, h });

/// Déplace ou redimensionne une fenêtre déjà logée.
const configure = (child, boite) => ordonner({ op: 'configure', child, ...boite }, 1500);

/// Remonte la fenêtre au-dessus de ses voisines.
const stack = (child) => ordonner({ op: 'stack', child }, 1500);

const map = (child) => ordonner({ op: 'map', child }, 1500);
const unmap = (child) => ordonner({ op: 'unmap', child }, 1500);

/// Rend la fenêtre au gestionnaire de fenêtres du système.
const release = (child, x = 120, y = 90) => ordonner({ op: 'release', child, x, y });

/// La fenêtre existe-t-elle encore ?
async function vivante(child) {
  const r = await ordonner({ op: 'alive', child }, 1500);
  return r.ok && r.alive === true;
}

function fermer() {
  if (!aide) return;
  const session = aide;
  aide = null;
  try { session.proc.kill(); } catch (_) {}
}

module.exports = { praticable, attendreFenetre, reparent, configure, stack, map, unmap, release, vivante, fermer };
