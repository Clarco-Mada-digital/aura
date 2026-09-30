'use strict';
// Le bureau : fond d'écran, widgets, icônes, et un gestionnaire de fenêtres.
//
// La contrainte qui gouverne tout, et qu'il faut avoir en tête avant de toucher
// à ce fichier : **une application logée est dessinée par le serveur X,
// au-dessus de tout le HTML**. Sa surface est un trou dans la page, qu'aucun
// élément ne peut recouvrir.
//
// D'où la forme des fenêtres : la barre de titre n'est pas *sur* l'application
// mais *au-dessus* d'elle, dans la bande qu'elle ne couvre pas ; la poignée de
// redimensionnement est *sous* son coin. Le cadre est un contour, pas un
// conteneur — c'est ce qui permet de le dessiner en HTML tout en laissant le
// serveur X peindre l'application.

const $ = (id) => document.getElementById(id);

const etat = {
  appareil: null,
  apps: [],
  sessions: [],
  notifications: [],
  disposition: null,
  ancrage: { ok: false, raison: null },
  actif: null,
};

const iconCache = new Map();

// ── Fonds livrés ────────────────────────────────────────────────────────────

const FONDS = [
  { id: 'nuit', css: 'linear-gradient(135deg, #171033 0%, #0b1226 55%, #04202b 100%)' },
  { id: 'brume', css: 'linear-gradient(135deg, #1d2333 0%, #131722 100%)' },
  { id: 'braise', css: 'linear-gradient(135deg, #2b1220 0%, #14121f 60%, #071018 100%)' },
  { id: 'foret', css: 'linear-gradient(135deg, #0e2420 0%, #0a1620 60%, #0a1020 100%)' },
  { id: 'aube', css: 'linear-gradient(135deg, #2a1a3a 0%, #1b1b3a 50%, #102436 100%)' },
  { id: 'encre', css: 'linear-gradient(135deg, #111319 0%, #0a0c12 100%)' },
];

function peindreFond() {
  const d = etat.disposition || {};
  const el = $('fond');
  if (d.fondImage) {
    el.style.backgroundImage = `url("file://${encodeURI(d.fondImage).replace(/"/g, '%22')}")`;
    el.style.background_ = '';
  } else {
    const choisi = FONDS.find((f) => f.id === d.fond) || FONDS[0];
    el.style.backgroundImage = choisi.css;
  }
}

// ── Icônes d'application ────────────────────────────────────────────────────

function teinte(pkg) {
  let h = 0;
  for (let i = 0; i < pkg.length; i++) h = (h * 31 + pkg.charCodeAt(i)) % 360;
  return h;
}

function elementIcone(app, petite = false) {
  const el = document.createElement('div');
  el.className = `app-icon${petite ? ' sm' : ''}`;
  const h = teinte(app.package);
  el.style.background = `linear-gradient(135deg, hsl(${h} 62% 52%), hsl(${(h + 48) % 360} 62% 42%))`;
  el.textContent = (app.name || app.package).trim()[0]?.toUpperCase() || '?';
  el.dataset.package = app.package;
  const connu = iconCache.get(app.package);
  if (connu) poser(el, connu);
  else if (connu === undefined) demanderIcone(app.package);
  return el;
}

function poser(el, icone) {
  const img = document.createElement('img');
  img.src = `data:${icone.mime};base64,${icone.data}`;
  img.alt = '';
  el.textContent = '';
  el.style.background = 'rgba(255,255,255,0.06)';
  el.appendChild(img);
}

// Une extraction à la fois : le câble USB est unique (même raison que dans le
// widget).
const file = [];
let vide = true;

function demanderIcone(pkg) {
  if (file.includes(pkg)) return;
  file.push(pkg);
  viderFile();
}

async function viderFile() {
  if (!vide) return;
  vide = false;
  while (file.length) {
    const pkg = file.shift();
    const icone = iconCache.has(pkg) ? iconCache.get(pkg) : await window.aura.icon(pkg).catch(() => null);
    iconCache.set(pkg, icone);
    if (!icone) continue;
    document.querySelectorAll(`.app-icon[data-package="${CSS.escape(pkg)}"]`).forEach((n) => {
      if (!n.querySelector('img')) poser(n, icone);
    });
  }
  vide = true;
}

// ── Widgets ────────────────────────────────────────────────────────────────

/// Position par défaut d'un widget, s'il n'en a pas encore.
const DEFAUTS = {
  horloge: { x: 48, y: 48 },
  appareil: { x: 48, y: 230 },
  notifs: { x: 48, y: 420 },
};

function rendreWidgets() {
  const hote = $('widgets');
  hote.textContent = '';
  const d = etat.disposition || {};
  const places = d.widgets || {};
  const actifs = d.widgetsActifs || ['horloge', 'appareil', 'notifs'];

  for (const nom of actifs) {
    const el = document.createElement('div');
    el.className = `widget w-${nom}`;
    const p = places[nom] || DEFAUTS[nom] || { x: 60, y: 60 };
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;

    if (nom === 'horloge') remplirHorloge(el);
    if (nom === 'appareil') remplirAppareil(el);
    if (nom === 'notifs') remplirNotifs(el);

    rendreDeplacable(el, (x, y) => {
      places[nom] = { x, y };
      enregistrer({ widgets: places });
    });
    hote.appendChild(el);
  }
}

function remplirHorloge(el) {
  const h = document.createElement('div');
  h.className = 'h';
  const d = document.createElement('div');
  d.className = 'd';
  el.append(h, d);
  const battre = () => {
    const now = new Date();
    h.textContent = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    d.textContent = now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  };
  battre();
  setInterval(battre, 10000);
}

function remplirAppareil(el) {
  const titre = document.createElement('div');
  titre.className = 'widget-titre';
  titre.textContent = 'Appareil';
  const nom = document.createElement('div');
  nom.className = 'nom';
  nom.textContent = etat.appareil ? etat.appareil.model : 'Aucun téléphone';
  el.append(titre, nom);

  if (!etat.appareil) return;

  if (etat.appareil.battery !== null && etat.appareil.battery !== undefined) {
    const jauge = document.createElement('div');
    jauge.className = `jauge${etat.appareil.battery <= 15 ? ' faible' : ''}`;
    const i = document.createElement('i');
    i.style.width = `${Math.max(2, etat.appareil.battery)}%`;
    jauge.appendChild(i);
    const ligne = document.createElement('div');
    ligne.className = 'ligne';
    ligne.textContent = `${etat.appareil.battery}%${etat.appareil.charging ? ' — en charge' : ''}`;
    el.append(jauge, ligne);
  }

  const android = document.createElement('div');
  android.className = 'ligne';
  android.textContent = `Android ${etat.appareil.android || '?'}`;
  el.appendChild(android);

  if (etat.reseau) {
    const r = document.createElement('div');
    r.className = 'ligne';
    const bouts = [];
    if (etat.reseau.wifi) bouts.push(etat.reseau.wifiConnected ? 'Wi-Fi connecté' : 'Wi-Fi allumé');
    if (etat.reseau.mobileData) bouts.push('données mobiles');
    if (etat.reseau.airplane) bouts.push('mode avion');
    r.textContent = bouts.join(' · ') || 'radios éteintes';
    el.appendChild(r);
  }
}

function remplirNotifs(el) {
  const titre = document.createElement('div');
  titre.className = 'widget-titre';
  titre.textContent = `Notifications${etat.notifications.length ? ` · ${etat.notifications.length}` : ''}`;
  el.appendChild(titre);

  if (!etat.notifications.length) {
    const rien = document.createElement('div');
    rien.className = 'aucune';
    rien.textContent = 'Rien pour l’instant.';
    el.appendChild(rien);
    return;
  }

  for (const n of etat.notifications.slice(0, 7)) {
    const app = etat.apps.find((a) => a.package === n.package) || { package: n.package, name: n.package };
    const ligne = document.createElement('div');
    ligne.className = 'n-item';
    ligne.appendChild(elementIcone(app, true));
    const textes = document.createElement('div');
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = n.title || app.name;
    const c = document.createElement('div');
    c.className = 'c';
    c.textContent = n.text || '';
    textes.append(t, c);
    ligne.appendChild(textes);
    // Un clic ouvre l'application qui l'a posée — le geste attendu.
    ligne.addEventListener('click', (e) => { e.stopPropagation(); lancer(n.package); });
    el.appendChild(ligne);
  }
}

// ── Icônes du bureau ───────────────────────────────────────────────────────

function rendreIcones() {
  const hote = $('icones');
  hote.textContent = '';
  const d = etat.disposition || {};
  const places = d.icones || {};
  const liste = d.raccourcis || [];

  liste.forEach((pkg, index) => {
    const app = etat.apps.find((a) => a.package === pkg);
    if (!app) return;
    const el = document.createElement('div');
    el.className = 'icone';
    const p = places[pkg] || { x: window.innerWidth - 130, y: 40 + index * 100 };
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;

    el.appendChild(elementIcone(app));
    const nom = document.createElement('div');
    nom.className = 'nom';
    nom.textContent = app.name;
    el.appendChild(nom);

    el.addEventListener('dblclick', () => lancer(pkg));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      retirerRaccourci(pkg);
    });
    rendreDeplacable(el, (x, y) => {
      places[pkg] = { x, y };
      enregistrer({ icones: places });
    });
    hote.appendChild(el);
  });
}

/// Rend un élément déplaçable à la souris, et prévient à la fin du geste.
///
/// Le déplacement se fait en CSS pendant le glissé — fluide, sans aller-retour
/// avec le processus principal — et n'est enregistré qu'au relâchement.
function rendreDeplacable(el, fini, pendant = null) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, .n-item')) return;
    e.preventDefault();
    const depart = { x: e.clientX, y: e.clientY };
    const base = { x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0 };
    el.classList.add('saisi');
    el.setPointerCapture(e.pointerId);

    const bouger = (ev) => {
      const x = Math.max(0, base.x + ev.clientX - depart.x);
      const y = Math.max(0, base.y + ev.clientY - depart.y);
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      if (pendant) pendant(x, y);
    };
    const lacher = () => {
      el.classList.remove('saisi');
      el.removeEventListener('pointermove', bouger);
      el.removeEventListener('pointerup', lacher);
      fini(parseFloat(el.style.left) || 0, parseFloat(el.style.top) || 0);
    };
    el.addEventListener('pointermove', bouger);
    el.addEventListener('pointerup', lacher);
  });
}

// ── Fenêtres logées ────────────────────────────────────────────────────────

const TITRE = 34;
const MARGE = 8;

/// Géométrie de chaque fenêtre, par identifiant de session.
const cadres = new Map();

/// Une place libre pour une nouvelle fenêtre, en cascade.
function placeLibre() {
  const n = cadres.size;
  const largeur = Math.min(880, Math.round(window.innerWidth * 0.52));
  const hauteur = Math.min(620, Math.round((window.innerHeight - 56) * 0.66));
  return {
    x: 260 + (n % 5) * 38,
    y: 70 + (n % 5) * 34,
    w: largeur,
    h: hauteur,
  };
}

function rendreCadres() {
  const hote = $('cadres');
  hote.textContent = '';

  for (const s of etat.sessions) {
    const g = cadres.get(s.id);
    if (!g) continue;

    if (g.vignette) { rendreVignette(s, g, hote); continue; }
    if (g.repliee) continue;

    const cadre = document.createElement('div');
    cadre.className = `cadre${etat.actif === s.id ? ' actif' : ''}`;
    cadre.style.left = `${g.x}px`;
    cadre.style.top = `${g.y}px`;
    cadre.style.width = `${g.w}px`;

    const titre = document.createElement('div');
    titre.className = 'titre';
    titre.textContent = s.name || s.package;
    cadre.appendChild(titre);

    cadre.appendChild(bouton('replier', 'Réduire', 'M6 12h12', () => replier(s.id, true)));
    cadre.appendChild(bouton('vignette', 'Épingler en vignette', 'M4 6h16M4 12h10M4 18h7', () => enVignette(s.id)));
    cadre.appendChild(bouton('fermer', 'Fermer', 'M6 6l12 12M18 6L6 18', () => fermerSession(s.id)));

    cadre.addEventListener('pointerdown', () => activer(s.id));
    rendreDeplacable(
      cadre,
      (x, y) => { g.x = x; g.y = y; poserFenetre(s.id); },
      (x, y) => { g.x = x; g.y = y; window.aura.place(s.id, boiteSurface(g)); }
    );
    hote.appendChild(cadre);

    // Poignée de redimensionnement, sous le coin inférieur droit.
    const poignee = document.createElement('div');
    poignee.className = 'poignee';
    poignee.style.left = `${g.x + g.w - 16}px`;
    poignee.style.top = `${g.y + TITRE + g.h}px`;
    poignee.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const depart = { x: e.clientX, y: e.clientY, w: g.w, h: g.h };
      poignee.setPointerCapture(e.pointerId);
      const bouger = (ev) => {
        g.w = Math.max(320, depart.w + ev.clientX - depart.x);
        g.h = Math.max(240, depart.h + ev.clientY - depart.y);
        cadre.style.width = `${g.w}px`;
        poignee.style.left = `${g.x + g.w - 16}px`;
        poignee.style.top = `${g.y + TITRE + g.h}px`;
        window.aura.place(s.id, boiteSurface(g));
      };
      const lacher = () => {
        poignee.removeEventListener('pointermove', bouger);
        poignee.removeEventListener('pointerup', lacher);
        poserFenetre(s.id);
      };
      poignee.addEventListener('pointermove', bouger);
      poignee.addEventListener('pointerup', lacher);
    });
    hote.appendChild(poignee);
  }
}

function rendreVignette(s, g, hote) {
  const v = document.createElement('div');
  v.className = 'vignette';
  v.style.left = `${g.x}px`;
  v.style.top = `${g.y}px`;
  v.style.width = `${g.w}px`;
  v.style.height = `${g.h}px`;
  v.title = `${s.name} — clic droit pour rendre la fenêtre`;
  v.addEventListener('contextmenu', (e) => { e.preventDefault(); horsVignette(s.id); });
  hote.appendChild(v);
}

function bouton(classe, titre, chemin, action) {
  const b = document.createElement('button');
  b.className = `bouton ${classe}`;
  b.title = titre;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', chemin);
  svg.appendChild(p);
  b.appendChild(svg);
  b.addEventListener('click', (e) => { e.stopPropagation(); action(); });
  return b;
}

/// La boîte de la **surface Android**, sous la barre de titre.
const boiteSurface = (g) => ({
  x: g.x,
  y: g.vignette ? g.y : g.y + TITRE,
  w: g.w,
  h: g.h,
});

function poserFenetre(id) {
  const g = cadres.get(id);
  if (!g) return;
  window.aura.place(id, boiteSurface(g));
  rendreCadres();
}

function activer(id) {
  if (etat.actif === id) return;
  etat.actif = id;
  window.aura.raise(id);
  rendreCadres();
  rendreTaches();
}

function replier(id, replie) {
  const g = cadres.get(id);
  if (!g) return;
  g.repliee = replie;
  window.aura.fold(id, replie);
  rendreCadres();
  rendreTaches();
}

function enVignette(id) {
  const g = cadres.get(id);
  if (!g) return;
  g.vignette = true;
  g.w = Math.round(g.w * 0.55);
  g.h = Math.round(g.h * 0.55);
  poserFenetre(id);
  message('Épinglée en vignette — clic droit dessus pour la rendre');
}

function horsVignette(id) {
  const g = cadres.get(id);
  if (!g) return;
  g.vignette = false;
  g.w = Math.round(g.w / 0.55);
  g.h = Math.round(g.h / 0.55);
  poserFenetre(id);
}

async function fermerSession(id) {
  cadres.delete(id);
  await window.aura.closeSession(id).catch(() => {});
  rendreCadres();
  rendreTaches();
}

// ── Barre des tâches ───────────────────────────────────────────────────────

function rendreTaches() {
  const hote = $('taches');
  hote.textContent = '';
  for (const s of etat.sessions) {
    const g = cadres.get(s.id);
    const t = document.createElement('button');
    t.className = `tache${etat.actif === s.id ? ' actif' : ''}${g && g.repliee ? ' repliee' : ''}`;
    const app = etat.apps.find((a) => a.package === s.package) || { package: s.package || '?', name: s.name };
    t.appendChild(elementIcone(app, true));
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = s.name || s.package;
    t.appendChild(n);
    t.addEventListener('click', () => {
      if (g && g.repliee) replier(s.id, false);
      activer(s.id);
    });
    hote.appendChild(t);
  }
}

function rendreBarre() {
  const now = new Date();
  $('heureBarre').textContent = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  $('etatAppareil').textContent = etat.appareil
    ? `${etat.appareil.model}${etat.appareil.battery !== null ? ` · ${etat.appareil.battery}%` : ''}`
    : 'aucun appareil';
}

// ── Lanceur ────────────────────────────────────────────────────────────────

function note(app, aiguille) {
  const nom = app.name.toLowerCase();
  const pkg = app.package.toLowerCase();
  if (nom === aiguille) return 1000;
  if (nom.startsWith(aiguille)) return 900 - nom.length;
  if (nom.split(/[\s\-_.]+/).some((m) => m.startsWith(aiguille))) return 700 - nom.length;
  if (nom.includes(aiguille)) return 500 - nom.length;
  if (pkg.includes(aiguille)) return 300 - pkg.length;
  return -1;
}

function rendreGrille() {
  const aiguille = $('recherche').value.trim().toLowerCase();
  const hote = $('grille');
  hote.textContent = '';

  const liste = aiguille
    ? etat.apps.map((a) => ({ a, s: note(a, aiguille) })).filter((r) => r.s >= 0)
        .sort((x, y) => y.s - x.s).slice(0, 60).map((r) => r.a)
    : etat.apps.filter((a) => !a.system).slice(0, 60);

  for (const app of liste) {
    const t = document.createElement('button');
    t.className = 'tuile';
    t.appendChild(elementIcone(app));
    const n = document.createElement('div');
    n.className = 'nom';
    n.textContent = app.name;
    t.appendChild(n);
    t.addEventListener('click', () => { fermerLanceur(); lancer(app.package); });
    // Clic droit : poser un raccourci sur le bureau.
    t.addEventListener('contextmenu', (e) => { e.preventDefault(); ajouterRaccourci(app.package); });
    hote.appendChild(t);
  }
}

const lanceurOuvert = () => !$('lanceur').hidden;

function ouvrirLanceur() {
  $('lanceur').hidden = false;
  $('recherche').value = '';
  rendreGrille();
  $('recherche').focus();
}

function fermerLanceur() {
  $('lanceur').hidden = true;
}

// ── Raccourcis ─────────────────────────────────────────────────────────────

function ajouterRaccourci(pkg) {
  const d = etat.disposition;
  const liste = d.raccourcis || [];
  if (liste.includes(pkg)) return message('Déjà sur le bureau');
  d.raccourcis = [...liste, pkg];
  enregistrer({ raccourcis: d.raccourcis });
  rendreIcones();
  message('Raccourci posé sur le bureau');
}

function retirerRaccourci(pkg) {
  const d = etat.disposition;
  d.raccourcis = (d.raccourcis || []).filter((p) => p !== pkg);
  enregistrer({ raccourcis: d.raccourcis });
  rendreIcones();
}

// ── Lancement ──────────────────────────────────────────────────────────────

async function lancer(pkg) {
  const place = placeLibre();
  message('Ouverture…');
  try {
    const r = await window.aura.launch(pkg, { boite: boiteSurface(place) });
    if (!r) return;
    cadres.set(r.id, place);
    if (!r.logee) {
      message(etat.ancrage.raison
        ? `Fenêtre ouverte à part — ${etat.ancrage.raison}`
        : "Fenêtre ouverte à part : elle n'a pas pu être logée dans le bureau", true);
      cadres.delete(r.id);
    } else {
      etat.actif = r.id;
    }
    rendreCadres();
    rendreTaches();
  } catch (err) {
    message(String(err.message || err).replace(/^Error invoking remote method '[^']*':\s*/, ''), true);
  }
}

// ── Disposition ────────────────────────────────────────────────────────────

let enregistrementDifféré = null;

function enregistrer(patch) {
  Object.assign(etat.disposition, patch);
  // Un glissé produit des dizaines de relâchements : on écrit une fois.
  clearTimeout(enregistrementDifféré);
  enregistrementDifféré = setTimeout(() => window.aura.setLayout(etat.disposition).catch(() => {}), 400);
}

// ── Messages ───────────────────────────────────────────────────────────────

let minuterieMessage = null;

function message(texte, erreur = false) {
  const el = $('toast');
  el.textContent = texte;
  el.className = `toast${erreur ? ' error' : ''}`;
  el.hidden = false;
  clearTimeout(minuterieMessage);
  minuterieMessage = setTimeout(() => { el.hidden = true; }, erreur ? 6500 : 2400);
}

// ── Fond d'écran ───────────────────────────────────────────────────────────

function ouvrirFonds() {
  const hote = $('fonds');
  hote.textContent = '';
  for (const f of FONDS) {
    const b = document.createElement('button');
    b.className = `fond-choix${etat.disposition.fond === f.id && !etat.disposition.fondImage ? ' actif' : ''}`;
    b.style.background = f.css;
    b.addEventListener('click', () => {
      etat.disposition.fondImage = null;
      enregistrer({ fond: f.id, fondImage: null });
      peindreFond();
      ouvrirFonds();
    });
    hote.appendChild(b);
  }
  $('voileFond').hidden = false;
}

// ── Démarrage ──────────────────────────────────────────────────────────────

async function demarrer() {
  const data = await window.aura.bootstrap();
  etat.appareil = data.device;
  etat.apps = data.apps || [];
  etat.sessions = data.sessions || [];
  etat.disposition = data.layout || {};
  etat.ancrage = data.ancrage || { ok: false };

  $('vide').hidden = Boolean(etat.appareil);

  peindreFond();
  rendreWidgets();
  rendreIcones();
  rendreBarre();
  rendreTaches();

  if (!etat.ancrage.ok) {
    message(`Les fenêtres ne peuvent pas être logées ici — ${etat.ancrage.raison}`, true);
  }

  window.aura.quickState().then((q) => {
    if (!q) return;
    etat.reseau = q.net;
    rendreWidgets();
  }).catch(() => {});

  window.aura.notifications().then((l) => {
    etat.notifications = l || [];
    rendreWidgets();
  }).catch(() => {});

  setInterval(rendreBarre, 20000);
}

// ── Branchements ───────────────────────────────────────────────────────────

$('btnLanceur').onclick = () => (lanceurOuvert() ? fermerLanceur() : ouvrirLanceur());
$('btnQuitter').onclick = () => window.aura.close();
$('btnFond').onclick = ouvrirFonds;
$('fondFermer').onclick = () => { $('voileFond').hidden = true; };
$('fondFichier').onclick = async () => {
  const chemin = await window.aura.pickWallpaper().catch(() => null);
  if (!chemin) return;
  enregistrer({ fondImage: chemin });
  peindreFond();
  $('voileFond').hidden = true;
};
$('recherche').addEventListener('input', rendreGrille);

$('lanceur').addEventListener('click', (e) => { if (e.target === $('lanceur')) fermerLanceur(); });
$('voileFond').addEventListener('click', (e) => { if (e.target === $('voileFond')) $('voileFond').hidden = true; });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (lanceurOuvert()) return fermerLanceur();
    if (!$('voileFond').hidden) return ($('voileFond').hidden = true);
  }
  // Une frappe sur le bureau ouvre le lanceur et s'y écrit.
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !lanceurOuvert() && e.target === document.body) {
    ouvrirLanceur();
    $('recherche').value = e.key;
    rendreGrille();
  }
});

window.aura.onSessions((liste) => {
  etat.sessions = liste;
  // Une session disparue emporte son cadre.
  for (const id of [...cadres.keys()]) {
    if (!liste.some((s) => s.id === id)) cadres.delete(id);
  }
  rendreCadres();
  rendreTaches();
});

window.aura.onNotifications((liste) => {
  etat.notifications = liste || [];
  rendreWidgets();
});

// La fenêtre du bureau a changé de taille : les fenêtres logées ne suivent pas
// toutes seules, il faut les reposer.
window.aura.onResized(() => {
  for (const id of cadres.keys()) window.aura.place(id, boiteSurface(cadres.get(id)));
  rendreCadres();
});

demarrer().catch((err) => message(String(err.message || err), true));
