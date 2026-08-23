'use strict';
// Interface du lanceur. Elle ne connaît ni adb ni scrcpy : tout passe par le
// pont `window.aura`.

const $ = (id) => document.getElementById(id);

const state = {
  settings: {},
  apps: [],
  device: null,
  devices: [],
  engine: null,
  error: null,
  sessions: [],
  notifications: [],
  query: '',
  mode: 'dock',
  selected: -1,
  results: [],
  refreshing: false,
  call: null,
};

const iconCache = new Map(); // paquet → { data, mime } ou null

// ── Recherche ───────────────────────────────────────────────────────────────

// Note de correspondance. Un préfixe vaut mieux qu'un début de mot, qui vaut
// mieux qu'une sous-chaîne : taper « wha » doit d'abord donner WhatsApp, pas
// une application dont le paquet contient « wha » au milieu.
function score(app, needle) {
  const name = app.name.toLowerCase();
  const pkg = app.package.toLowerCase();
  if (name === needle) return 1000;
  if (name.startsWith(needle)) return 900 - name.length;
  const words = name.split(/[\s\-_.]+/);
  if (words.some((w) => w.startsWith(needle))) return 700 - name.length;
  if (name.includes(needle)) return 500 - name.length;
  if (pkg.includes(needle)) return 300 - pkg.length;

  // Sous-séquence : « gmp » retrouve « Google Maps ».
  let i = 0;
  for (const ch of name) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return 120 - name.length;
  }
  return -1;
}

// Nombre de résultats montrés en recherche. Une liste courte se lit d'un coup
// d'œil ; au-delà, on affine sa recherche plutôt que de faire défiler.
const MAX_HITS = 8;

const DIAL = '__composer__';
const LIEN = '__lien__';

/// Dernier état connu du vérificateur de mise à jour.
let updateState = null;

/// Le texte saisi, s'il ressemble à un numéro de téléphone.
///
/// Quatre chiffres au minimum : en dessous, « 12 » ou « 007 » sont bien plus
/// souvent le début du nom d'une application qu'un numéro à appeler.
function asNumber(query) {
  const brut = String(query).trim();
  if (!/^[+0-9][0-9 .\-()]*$/.test(brut)) return null;
  const chiffres = brut.replace(/[^0-9+]/g, '');
  return chiffres.replace(/[^0-9]/g, '').length >= 4 ? chiffres : null;
}

function compute() {
  const needle = state.query.trim().toLowerCase();

  if (!needle) {
    // Au repos, le widget ne montre que ce qui a été épinglé — et, tant qu'il
    // n'y a pas de favoris, les dernières applications ouvertes.
    const favorites = (state.settings.favorites || [])
      .map((p) => state.apps.find((a) => a.package === p))
      .filter(Boolean);
    const recents = (state.settings.recents || [])
      .map((p) => state.apps.find((a) => a.package === p))
      .filter(Boolean);
    state.mode = 'dock';
    state.results = favorites.length ? favorites : recents.slice(0, 5);
    state.selected = -1; // rien de présélectionné : le dock se clique
    return;
  }

  state.mode = 'hits';
  const hits = state.apps
    .filter((a) => state.settings.showSystemApps || !a.system || isFavorite(a.package))
    .map((a) => ({ a, s: score(a, needle) }))
    .filter((r) => r.s >= 0)
    .sort((x, y) => y.s - x.s)
    .slice(0, MAX_HITS)
    .map((r) => r.a);

  // Un numéro tapé dans la barre de recherche mène au composeur, avec le
  // numéro déjà en place. C'est le geste qu'on attend d'un lanceur relié à un
  // téléphone, et il ne coûte qu'une ligne de plus dans la liste.
  const numero = asNumber(state.query);
  // Une adresse collée dans la barre continue sur le téléphone : c'est le
  // même geste que le numéro, et le lien s'ouvre dans l'application qui en a
  // la charge — navigateur, boutique, cartes.
  const lien = adresseDe(state.query);
  const tête = [];
  if (numero) tête.push({ package: DIAL, name: `Appeler ${numero}`, dial: numero, system: false });
  if (lien) tête.push({ package: LIEN, name: `Ouvrir ${lien} sur le téléphone`, url: lien, system: false });
  state.results = tête.length ? [...tête, ...hits] : hits;
  state.selected = 0;
}

// ── Icônes ──────────────────────────────────────────────────────────────────

// Pastille de repli : deux teintes dérivées du nom du paquet, pour qu'une même
// application garde toujours la même couleur.
function hue(pkg) {
  let h = 0;
  for (let i = 0; i < pkg.length; i++) h = (h * 31 + pkg.charCodeAt(i)) % 360;
  return h;
}

function iconElement(app, size) {
  const el = document.createElement('div');
  el.className = `app-icon ${size}`;
  const h = hue(app.package);
  el.style.background = `linear-gradient(135deg, hsl(${h} 62% 52%), hsl(${(h + 48) % 360} 62% 42%))`;
  el.textContent = app.name.trim()[0]?.toUpperCase() || '?';
  el.dataset.package = app.package;

  const known = iconCache.get(app.package);
  if (known) paint(el, known);
  else if (known === undefined) requestIcon(app.package);
  return el;
}

function paint(el, icon) {
  const img = document.createElement('img');
  img.src = `data:${icon.mime};base64,${icon.data}`;
  img.alt = '';
  el.textContent = '';
  el.style.background = 'rgba(255,255,255,0.06)';
  el.appendChild(img);
}

// Une seule extraction à la fois : un seul câble USB relie le téléphone, et
// vingt demandes de front ne font que se gêner.
//
// La file porte des noms de paquets, pas des éléments : la grille se redessine
// à chaque frappe, et un élément mis en file serait déjà remplacé au moment où
// son icône arrive. Le paquet, lui, retrouve toujours ses vignettes.
const iconQueue = [];
let draining = false;

function requestIcon(pkg) {
  if (iconQueue.includes(pkg)) return;
  iconQueue.push(pkg);
  drainIcons();
}

async function drainIcons() {
  if (draining) return;
  draining = true;
  while (iconQueue.length) {
    const pkg = iconQueue.shift();
    if (iconCache.has(pkg)) { applyIcon(pkg, iconCache.get(pkg)); continue; }
    const icon = await window.aura.icon(pkg).catch(() => null);
    iconCache.set(pkg, icon);
    applyIcon(pkg, icon);
  }
  draining = false;
}

function applyIcon(pkg, icon) {
  if (!icon) return;
  document.querySelectorAll(`.app-icon[data-package="${CSS.escape(pkg)}"]`).forEach((node) => {
    if (!node.querySelector('img')) paint(node, icon);
  });
}

// ── Rendu ───────────────────────────────────────────────────────────────────

const isFavorite = (pkg) => (state.settings.favorites || []).includes(pkg);

function renderDevice() {
  const dot = $('dot');
  const name = $('deviceName');
  const meta = $('deviceMeta');
  const pill = $('device');

  // Plusieurs téléphones branchés : le pilote devient un sélecteur.
  const multi = (state.devices || []).length > 1;
  pill.classList.toggle('multi', multi);
  pill.title = multi ? 'Choisir l’appareil actif' : '';

  if (state.device) {
    dot.className = 'dot on';
    name.textContent = state.device.model;
    const bits = [];
    if (state.device.battery !== null) bits.push(`${state.device.battery}%${state.device.charging ? ' ⚡' : ''}`);
    if (multi) bits.push(`${state.devices.length} appareils`);
    meta.textContent = bits.length ? `· ${bits.join(' · ')}` : '';
  } else {
    dot.className = 'dot off';
    name.textContent = 'Aucun appareil';
    meta.textContent = '';
  }
}

function renderStage() {
  const dock = $('dock');
  const hits = $('hits');
  const empty = $('empty');
  dock.textContent = '';
  hits.textContent = '';
  empty.hidden = true;
  empty.textContent = '';

  if (state.mode === 'hits') {
    dock.hidden = true;
    hits.hidden = false;
    renderHits();
    return fit();
  }

  hits.hidden = true;
  dock.hidden = false;
  renderDock();
  fit();
}

// Le dock : les applications épinglées, et rien d'autre.
function renderDock() {
  const dock = $('dock');

  if (!state.apps.length) return renderNoApps();

  if (!state.results.length) {
    dock.hidden = true;
    $('empty').hidden = false;
    fillEmpty(
      'Aucun favori pour l’instant',
      'Cherchez une application ci-dessus, puis ★ pour l’épingler ici.'
    );
    return;
  }

  state.results.forEach((app, index) => {
    const tile = document.createElement('div');
    tile.className = `fav${index === state.selected ? ' sel' : ''}`;
    tile.draggable = isFavorite(app.package);
    tile.dataset.package = app.package;
    tile.title = `${app.name}\n${app.package}`;

    tile.appendChild(iconElement(app, 'lg'));
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = app.name;
    tile.appendChild(label);

    const unpin = document.createElement('button');
    unpin.className = 'unpin';
    unpin.textContent = '✕';
    unpin.title = isFavorite(app.package) ? 'Retirer des favoris' : 'Épingler';
    unpin.onclick = (e) => { e.stopPropagation(); toggleFavorite(app.package); };
    tile.appendChild(unpin);

    tile.addEventListener('click', () => launch(app.package));
    tile.addEventListener('mouseenter', () => select(index, false));
    tile.addEventListener('contextmenu', (e) => { e.preventDefault(); openAppMenu(app, e.clientX, e.clientY); });
    bindReorder(tile, dock);
    dock.appendChild(tile);
  });

  // Un emplacement libre rappelle qu'on peut en ajouter, sans occuper de place
  // réelle : il complète simplement la dernière ligne.
  const slot = document.createElement('div');
  slot.className = 'slot';
  slot.textContent = '+';
  slot.title = 'Cherchez une application, puis ★ pour l’épingler';
  slot.onclick = () => $('query').focus();
  dock.appendChild(slot);
}

// Les résultats de recherche : une liste courte, dense, sans fioriture.
function renderHits() {
  const hits = $('hits');

  if (!state.apps.length) return renderNoApps();

  if (!state.results.length) {
    hits.hidden = true;
    $('empty').hidden = false;
    fillEmpty('Aucune correspondance', `« ${state.query} » n’a rien donné. Essayez le nom du paquet.`);
    return;
  }

  state.results.forEach((app, index) => {
    const row = document.createElement('div');
    row.className = `hit${index === state.selected ? ' sel' : ''}`;

    // Les deux entrées qui ne sont pas des applications : appeler un numéro,
    // pousser une adresse. Même dessin, même comportement au clavier.
    if (app.dial || app.url) {
      const glyphe = document.createElement('div');
      glyphe.className = `app-icon sm ${app.dial ? 'dial' : 'link'}`;
      glyphe.innerHTML = app.dial
        ? '<svg viewBox="0 0 24 24"><path d="M6.6 3.5l2.6.5 1 3.4-2 1.4a12 12 0 0 0 5 5l1.4-2 3.4 1 .5 2.6a2 2 0 0 1-2 2.3A15.5 15.5 0 0 1 4.3 5.5a2 2 0 0 1 2.3-2Z"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 1 0-5.7-5.7L11.5 6.8"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 1 0 11 18.7l1.4-1.4"/></svg>';
      const texts = document.createElement('div');
      texts.className = 'texts';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = app.name;
      const sub = document.createElement('div');
      sub.className = 'pkg';
      sub.textContent = app.dial
        ? 'Ouvre le composeur, le numéro déjà saisi'
        : "S'ouvre dans l'application du téléphone qui en a la charge";
      texts.append(name, sub);
      row.append(glyphe, texts);
      row.addEventListener('click', () => launch(app.package, null, app.dial, app.url));
      row.addEventListener('mouseenter', () => select(index, false));
      hits.appendChild(row);
      return;
    }

    row.appendChild(iconElement(app, 'sm'));

    const texts = document.createElement('div');
    texts.className = 'texts';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = app.name;
    const pkg = document.createElement('div');
    pkg.className = 'pkg';
    pkg.textContent = app.package;
    texts.append(name, pkg);
    row.appendChild(texts);

    const star = document.createElement('button');
    star.className = `star${isFavorite(app.package) ? ' on' : ''}`;
    star.title = isFavorite(app.package) ? 'Retirer des favoris' : 'Ajouter aux favoris';
    star.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z"/></svg>';
    star.addEventListener('click', (e) => { e.stopPropagation(); toggleFavorite(app.package); });
    row.appendChild(star);

    row.addEventListener('click', () => launch(app.package));
    row.addEventListener('mouseenter', () => select(index, false));
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); openAppMenu(app, e.clientX, e.clientY); });
    hits.appendChild(row);
  });
}

function renderNoApps() {
  $('dock').hidden = true;
  $('hits').hidden = true;
  $('empty').hidden = false;

  // Le moteur vidéo manque ou est trop ancien : c'est le seul cas où
  // l'utilisateur ne peut rien faire de lui-même depuis l'interface, alors
  // l'application propose de s'en charger.
  if (state.error && !state.engine) {
    return renderEngineMissing();
  }

  if (state.error) {
    fillEmpty('Appareil indisponible', state.error, 'Réessayer', () => reconnect());
  } else {
    fillEmpty(
      'Inventaire à construire',
      'scrcpy interroge le téléphone pour connaître ses applications. Comptez une vingtaine de secondes la première fois.',
      'Charger les applications',
      () => refreshApps()
    );
  }
}

function renderEngineMissing() {
  const empty = $('empty');
  empty.textContent = '';

  const strong = document.createElement('strong');
  strong.textContent = 'Le moteur vidéo manque';
  const line = document.createElement('span');
  line.textContent = state.error;
  empty.append(strong, line);

  if (!state.installTarget) {
    // Pas d'archive officielle pour cette machine : mieux vaut le dire que
    // d'afficher un bouton qui ne mènerait nulle part.
    const note = document.createElement('span');
    note.className = 'idle';
    note.textContent = 'Installez scrcpy 3.0 ou plus récent par votre distribution, puis réessayez.';
    const retry = document.createElement('button');
    retry.className = 'cta';
    retry.textContent = 'Réessayer';
    retry.onclick = () => reconnect();
    empty.append(note, retry);
    return;
  }

  const cta = document.createElement('button');
  cta.className = 'cta';
  cta.textContent = `Installer scrcpy ${state.installVersion} (${state.installSize} Mo)`;

  const bar = document.createElement('div');
  bar.className = 'progress';
  bar.hidden = true;
  const fill = document.createElement('div');
  bar.appendChild(fill);

  const note = document.createElement('span');
  note.className = 'idle';
  note.textContent = 'Téléchargé depuis github.com/Genymobile/scrcpy, empreinte vérifiée. Contient aussi adb.';

  window.aura.onEngineProgress((progress) => {
    bar.hidden = false;
    if (progress.phase === 'download') {
      const percent = progress.total ? Math.round((progress.received / progress.total) * 100) : 0;
      fill.style.width = `${percent}%`;
      note.textContent = `Téléchargement… ${percent} %`;
    } else if (progress.phase === 'verify') {
      note.textContent = 'Vérification de l’empreinte…';
    } else if (progress.phase === 'extract') {
      fill.style.width = '100%';
      note.textContent = 'Installation…';
    }
  });

  cta.onclick = async () => {
    cta.disabled = true;
    try {
      const engine = await window.aura.installEngine();
      toast(`scrcpy ${engine.version} installé`);
      await reconnect();
      if (state.device && !state.apps.length) refreshApps();
    } catch (err) {
      cta.disabled = false;
      bar.hidden = true;
      note.textContent = messageErreur(err);
      toast('Installation impossible', true);
    }
  };

  empty.append(cta, bar, note);
}

function fillEmpty(title, line, action, onAction) {
  const empty = $('empty');
  empty.textContent = '';
  const strong = document.createElement('strong');
  strong.textContent = title;
  const text = document.createElement('span');
  text.textContent = line;
  empty.append(strong, text);
  if (action) {
    const cta = document.createElement('button');
    cta.className = 'cta';
    cta.textContent = action;
    cta.onclick = onAction;
    empty.appendChild(cta);
  }
}

// Réordonnancement des favoris par glisser-déposer.
function bindReorder(tile, row) {
  tile.addEventListener('dragstart', (e) => {
    tile.classList.add('dragging');
    e.dataTransfer.setData('text/plain', tile.dataset.package);
    e.dataTransfer.effectAllowed = 'move';
  });
  tile.addEventListener('dragend', () => tile.classList.remove('dragging'));
  tile.addEventListener('dragover', (e) => { e.preventDefault(); tile.classList.add('drop-target'); });
  tile.addEventListener('dragleave', () => tile.classList.remove('drop-target'));
  tile.addEventListener('drop', async (e) => {
    e.preventDefault();
    tile.classList.remove('drop-target');
    const moved = e.dataTransfer.getData('text/plain');
    if (!moved || moved === tile.dataset.package) return;
    const order = [...row.children].map((c) => c.dataset.package).filter((p) => p && p !== moved);
    order.splice(order.indexOf(tile.dataset.package), 0, moved);
    state.settings.favorites = await window.aura.reorderFavorites(order);
    compute();
    renderStage();
  });
}

function renderSessions() {
  const running = $('running');
  running.textContent = '';
  if (!state.sessions.length) {
    const hint = document.createElement('span');
    hint.className = 'idle';
    hint.textContent = 'Aucune fenêtre ouverte';
    running.appendChild(hint);
    return;
  }
  state.sessions.forEach((s) => {
    const chip = document.createElement('div');
    chip.className = 'chip';
    const live = document.createElement('span');
    live.className = `live${s.state === 'starting' ? ' starting' : ''}`;
    const label = document.createElement('span');
    label.textContent = s.name + (s.displayId !== null && s.displayId !== undefined ? ` · écran ${s.displayId}` : '');
    const close = document.createElement('button');
    close.textContent = '✕';
    close.title = 'Fermer la fenêtre';
    close.onclick = (e) => { e.stopPropagation(); window.aura.closeSession(s.id); };

    // Un clic ramène la fenêtre au premier plan, ou la réduit si elle y est
    // déjà — comme une barre des tâches.
    chip.classList.add('clickable');
    chip.title = `${s.name} — cliquez pour afficher ou réduire`;
    chip.onclick = async () => {
      const result = await window.aura.toggleSession(s.id).catch(() => null);
      if (result && result.action === 'none') toast(result.reason || 'fenêtre injoignable', true);
    };

    chip.append(live, label, close);
    running.appendChild(chip);
  });
}

function renderNotifications() {
  const list = $('notifList');
  const badge = $('notifBadge');
  list.textContent = '';

  badge.hidden = state.notifications.length === 0;
  badge.textContent = state.notifications.length > 99 ? '99+' : String(state.notifications.length);
  $('btnClearAll').hidden = state.notifications.length === 0;

  if (!state.notifications.length) {
    const empty = document.createElement('div');
    empty.className = 'idle';
    empty.style.padding = '20px 4px';
    empty.textContent = state.device
      ? 'Rien à signaler pour le moment.'
      : 'Connectez le téléphone pour voir ses notifications.';
    list.appendChild(empty);
    return;
  }

  // Le geste n'est pas devinable : on le dit une fois, discrètement.
  const hint = document.createElement('div');
  hint.className = 'idle';
  hint.style.padding = '0 2px 2px';
  hint.textContent = 'Balayez pour écarter · cliquez pour ouvrir l’application';
  list.appendChild(hint);

  state.notifications.forEach((n) => {
    const app = state.apps.find((a) => a.package === n.package) || { name: n.package, package: n.package };
    const row = document.createElement('div');
    row.className = 'notif';
    row.title = `Ouvrir ${app.name} — ou balayez pour écarter`;
    row.appendChild(iconElement(app, 'sm'));

    const texts = document.createElement('div');
    texts.className = 'texts';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = n.title || app.name;
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = n.text || '';
    const when = document.createElement('div');
    when.className = 'when';
    when.textContent = [app.name, relative(n.when)].filter(Boolean).join(' · ');
    texts.append(title, body, when);
    row.appendChild(texts);

    const drop = document.createElement('button');
    drop.className = 'drop';
    drop.textContent = '✕';
    drop.title = 'Écarter';
    drop.onclick = (e) => { e.stopPropagation(); dismiss(n, row); };
    row.appendChild(drop);

    // Cliquer ouvre l'application qui a posé la notification, dans sa propre
    // fenêtre : c'est le geste attendu, et le seul qu'ADB permette — les
    // intentions attachées à une notification ne sont pas déclenchables d'ici.
    row.addEventListener('click', () => {
      if (row.dataset.swiped) { delete row.dataset.swiped; return; }
      if (state.apps.some((a) => a.package === n.package)) {
        launch(n.package);
        openPanel(null);
      } else {
        toast(`${app.name} n'est pas dans l'inventaire`, true);
      }
    });

    bindSwipe(row, n);
    list.appendChild(row);
  });
}

// Balayage horizontal, comme sur le téléphone : au-delà d'un tiers de la
// largeur, la notification part ; en deçà, elle revient en place.
function bindSwipe(row, notif) {
  let startX = 0;
  let dx = 0;
  let dragging = false;

  row.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // La croix ne doit pas déclencher le balayage : capturer le pointeur ici
    // redirigerait le clic qui suit vers la ligne, et la notification
    // s'ouvrirait au lieu de partir.
    if (e.target.closest('.drop')) return;
    dragging = true;
    startX = e.clientX;
    dx = 0;
    row.setPointerCapture(e.pointerId);
    row.classList.add('swiping');
  });

  row.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dx = e.clientX - startX;
    row.style.transform = `translateX(${dx}px)`;
    row.style.opacity = String(Math.max(0.15, 1 - Math.abs(dx) / (row.offsetWidth * 0.9)));
  });

  const settle = (e) => {
    if (!dragging) return;
    dragging = false;
    row.classList.remove('swiping');
    try { row.releasePointerCapture(e.pointerId); } catch (_) {}

    if (Math.abs(dx) > row.offsetWidth / 3) {
      // Le clic qui suit le relâchement ne doit pas ouvrir l'application.
      row.dataset.swiped = '1';
      dismiss(notif, row, dx > 0 ? 1 : -1);
      return;
    }
    row.style.transform = '';
    row.style.opacity = '';
    if (Math.abs(dx) > 4) row.dataset.swiped = '1';
  };

  row.addEventListener('pointerup', settle);
  row.addEventListener('pointercancel', settle);
}

async function dismiss(notif, row, direction = 1) {
  row.classList.add('gone');
  row.style.transform = `translateX(${direction * row.offsetWidth}px)`;
  row.style.opacity = '0';

  const ok = await window.aura.dismissNotification(notif.key).catch(() => false);
  if (!ok) {
    // L'appareil a refusé : on remet la notification en place plutôt que de
    // laisser croire qu'elle est partie.
    row.classList.remove('gone');
    row.style.transform = '';
    row.style.opacity = '';
    delete row.dataset.swiped;
    return toast("Impossible d'écarter cette notification", true);
  }

  state.notifications = state.notifications.filter((n) => n.key !== notif.key);
  setTimeout(() => { renderNotifications(); }, 200);
}

async function dismissAll() {
  const keys = state.notifications.map((n) => n.key);
  if (!keys.length) return;
  toast('Nettoyage…');
  const done = await window.aura.dismissAllNotifications(keys).catch(() => 0);
  state.notifications = [];
  renderNotifications();
  toast(done ? `${done} notification${done > 1 ? 's' : ''} écartée${done > 1 ? 's' : ''}` : 'Rien n’a pu être écarté', !done);
}

function relative(when) {
  if (!when) return '';
  const delta = Math.max(0, Date.now() - when);
  const minutes = Math.round(delta / 60000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return new Date(when).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// ── Réglages ────────────────────────────────────────────────────────────────

function renderSettings() {
  const body = $('settingsBody');
  body.textContent = '';

  const group = (label) => {
    const el = document.createElement('div');
    el.className = 'settings-group';
    el.textContent = label;
    body.appendChild(el);
  };

  const field = (label, desc, control) => {
    const row = document.createElement('div');
    row.className = 'field';
    const texts = document.createElement('div');
    const lab = document.createElement('div');
    lab.className = 'lab';
    lab.textContent = label;
    texts.appendChild(lab);
    if (desc) {
      const d = document.createElement('div');
      d.className = 'desc';
      d.textContent = desc;
      texts.appendChild(d);
    }
    row.append(texts, control);
    body.appendChild(row);
    return row;
  };

  const toggle = (key) => {
    const el = document.createElement('div');
    el.className = `switch${state.settings[key] ? ' on' : ''}`;
    el.setAttribute('role', 'switch');
    el.tabIndex = 0;
    const flip = async () => {
      state.settings = await window.aura.saveSettings({ [key]: !state.settings[key] });
      el.classList.toggle('on', !!state.settings[key]);
      if (key === 'showSystemApps') { compute(); renderStage(); }
      if (key === 'blurWallpaper') window.aura.refreshWallpaper();
    };
    el.onclick = flip;
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } };
    return el;
  };

  const select = (key, options) => {
    const el = document.createElement('select');
    options.forEach(([value, label]) => {
      const opt = document.createElement('option');
      opt.value = String(value);
      opt.textContent = label;
      if (String(state.settings[key]) === String(value)) opt.selected = true;
      el.appendChild(opt);
    });
    el.onchange = async () => {
      const raw = el.value;
      const value = /^-?\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : raw;
      state.settings = await window.aura.saveSettings({ [key]: value });
    };
    return el;
  };

  const size = document.createElement('select');
  [[1280, 800], [1600, 900], [1920, 1080], [1024, 768], [900, 1600]].forEach(([w, h]) => {
    const opt = document.createElement('option');
    opt.value = `${w}x${h}`;
    opt.textContent = `${w} × ${h}`;
    if (state.settings.width === w && state.settings.height === h) opt.selected = true;
    size.appendChild(opt);
  });
  size.onchange = async () => {
    const [w, h] = size.value.split('x').map(Number);
    state.settings = await window.aura.saveSettings({ width: w, height: h });
  };

  group('Fenêtres d’application');
  field('Définition', "Écran virtuel Android : sa forme et sa netteté", size);
  field('Densité', '160 ppp donne une mise en page de tablette', select('dpi', [[120, '120 ppp'], [160, '160 ppp'], [240, '240 ppp'], [320, '320 ppp']]));
  field('Taille à l’ouverture', "Part de l'écran occupée par la fenêtre",
    select('windowScale', [[0.35, 'Petite — 35 %'], [0.45, 'Réduite — 45 %'], [0.55, 'Moyenne — 55 %'], [0.7, 'Grande — 70 %'], [0.85, 'Très grande — 85 %']]));
  field('Suivre la fenêtre', "Android relaie une surface plus petite. Décoché, l'image est simplement mise à l'échelle — plus net", toggle('flex'));
  field('Garder actif', "L'écran virtuel ne s'éteint pas", toggle('keepActive'));
  field('Son de l’appareil', 'Redirige l’audio vers l’ordinateur (Android 11+)', toggle('audio'));
  field('Codec vidéo', 'H.265 pour les grandes fenêtres, si l’appareil suit', select('codec', [['h264', 'H.264'], ['h265', 'H.265'], ['av1', 'AV1']]));
  field('Débit', 'Plus haut = plus net, plus de bande passante', select('bitrate', [['4M', '4 Mb/s'], ['8M', '8 Mb/s'], ['16M', '16 Mb/s'], ['24M', '24 Mb/s']]));
  field('Images par seconde', '', select('maxFps', [[30, '30 i/s'], [60, '60 i/s'], [90, '90 i/s'], [120, '120 i/s']]));
  field('Sans décor système', 'Masque la barre de navigation de l’écran virtuel', toggle('noSystemDecorations'));

  group('Lanceur');
  field('Toujours au-dessus', '', toggle('alwaysOnTop'));
  field('Masquer après ouverture', '', toggle('hideAfterLaunch'));
  field('Fond flouté', 'Photographie l’écran et la floute sous le verre', toggle('blurWallpaper'));
  field('Alertes du bureau', 'Message ou appel annoncé même widget masqué', toggle('desktopNotifications'));
  field('Appel au premier plan', 'Un appel entrant fait apparaître le widget', toggle('raiseOnCall'));
  field('Hauteur libre', 'La fenêtre cesse de s’ajuster au contenu', toggle('freeHeight'));
  field('Applications système', 'Affiche aussi les applications préinstallées', toggle('showSystemApps'));

  // Le raccourci se capture au clavier plutôt qu'il ne se tape : une chaîne
  // saisie à la main peut désigner une combinaison qu'aucun système ne sait
  // enregistrer — AltGr, par exemple, est une touche de composition.
  const hotkey = document.createElement('button');
  hotkey.className = 'ghost keycap';
  hotkey.textContent = prettyHotkey(state.settings.hotkey) || 'Aucun';

  let capturing = false;
  const stopCapture = () => {
    capturing = false;
    hotkey.classList.remove('capturing');
    hotkey.textContent = prettyHotkey(state.settings.hotkey) || 'Aucun';
    window.removeEventListener('keydown', onCapture, true);
  };

  async function onCapture(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') return stopCapture();

    const accelerator = toAccelerator(e);
    if (!accelerator) {
      hotkey.textContent = e.getModifierState('AltGraph')
        ? 'AltGr est impossible'
        : 'Ajoutez Ctrl, Alt ou Super';
      return;
    }

    window.removeEventListener('keydown', onCapture, true);
    capturing = false;
    hotkey.classList.remove('capturing');
    await applyHotkey(accelerator);
    hotkey.textContent = prettyHotkey(state.settings.hotkey) || 'Aucun';
  }

  hotkey.onclick = () => {
    if (capturing) return stopCapture();
    capturing = true;
    hotkey.classList.add('capturing');
    hotkey.textContent = 'Tapez la combinaison…';
    window.addEventListener('keydown', onCapture, true);
  };

  field('Raccourci global', 'Cliquez, puis tapez la combinaison (Échap annule)', hotkey);

  group('Entretien');
  const refresh = document.createElement('button');
  refresh.className = 'ghost';
  refresh.textContent = 'Actualiser';
  refresh.onclick = () => refreshApps();
  field('Inventaire des applications', collected(), refresh);

  const clear = document.createElement('button');
  clear.className = 'ghost';
  clear.textContent = 'Vider le cache';
  clear.onclick = async () => {
    await window.aura.clearIcons();
    iconCache.clear();
    renderAll();
    toast('Cache des icônes vidé');
  };
  field('Icônes', 'À refaire après une mise à jour des applications', clear);

  const quit = document.createElement('button');
  quit.className = 'ghost';
  quit.textContent = 'Quitter Aura';
  quit.onclick = () => window.aura.quit();
  field('Application', state.engine ? `scrcpy ${state.engine.version}` : 'moteur introuvable', quit);

  // ── Diagnostic ────────────────────────────────────────────────────────────
  // Une application qui ne s'ouvre pas ne dit rien d'elle-même : le processus
  // meurt en une seconde, hors de tout terminal. Ce bloc rassemble ce qu'il
  // faut pour comprendre — et surtout pour le recopier dans un signalement.
  // ── Mise à jour ───────────────────────────────────────────────────────────
  group('Mise à jour');

  const etat = document.createElement('div');
  etat.className = 'desc';

  const bouton = document.createElement('button');
  bouton.className = 'ghost';

  const peindre = (u) => {
    const paquet = u && u.packaged !== false;
    if (!paquet) {
      etat.textContent = 'Version de développement — la mise à jour ne s’applique qu’à une application installée.';
      bouton.textContent = 'Indisponible';
      bouton.disabled = true;
      return;
    }
    bouton.disabled = false;
    switch (u.statut) {
      case 'vérification':
        etat.textContent = 'Vérification…'; bouton.textContent = 'Patientez'; bouton.disabled = true; break;
      case 'disponible':
        etat.textContent = `Aura ${u.version} est disponible.`; bouton.textContent = 'Télécharger'; break;
      case 'téléchargement':
        etat.textContent = `Téléchargement — ${u.progression} %`; bouton.textContent = 'En cours'; bouton.disabled = true; break;
      case 'prête':
        etat.textContent = `Aura ${u.version} est prête à s’installer.`; bouton.textContent = 'Redémarrer'; break;
      case 'erreur':
        etat.textContent = `Échec : ${u.erreur}`; bouton.textContent = 'Réessayer'; break;
      case 'à jour':
        etat.textContent = 'Aucune version plus récente.'; bouton.textContent = 'Vérifier'; break;
      default:
        etat.textContent = 'Non vérifié depuis le démarrage.'; bouton.textContent = 'Vérifier';
    }
  };

  bouton.onclick = async () => {
    const u = updateState || {};
    if (u.statut === 'prête') return window.aura.installUpdate();
    if (u.statut === 'disponible') { updateState = await window.aura.downloadUpdate(); return peindre(updateState); }
    updateState = await window.aura.checkUpdate();
    peindre(updateState);
  };

  window.aura.updateState().then((u) => { updateState = u; peindre(u); });
  peindre(updateState);
  field('Version installée', `Aura ${state.version || ''}`.trim(), bouton);
  body.appendChild(etat);

  group('Diagnostic');

  const voir = document.createElement('button');
  voir.className = 'ghost';
  voir.textContent = 'Ouvrir';
  voir.onclick = () => window.aura.openDiagnostic();
  field('État du système', 'Moteur, appareil, session graphique, dernier échec', voir);

  const copier = document.createElement('button');
  copier.className = 'ghost';
  copier.textContent = 'Copier';
  copier.onclick = async () => {
    await navigator.clipboard.writeText(await window.aura.diagnosticText());
    toast('Diagnostic copié');
  };
  field('Rapport', 'À coller dans un signalement', copier);

  const journal = document.createElement('button');
  journal.className = 'ghost';
  journal.textContent = 'Ouvrir le journal';
  journal.onclick = async () => {
    const ok = await window.aura.openLog();
    if (!ok) toast('Journal indisponible', true);
  };
  field('Journal', 'Chaque lancement et chaque erreur y sont écrits', journal);
}



function collected() {
  if (!state.collectedAt) return 'jamais collecté';
  return `collecté ${relative(state.collectedAt)}`;
}

// ── Menu par application ────────────────────────────────────────────────────

// Deux formats de lancement. Le portrait fige l'écran et verrouille la
// rotation : c'est la sortie de boucle pour les applications qui imposent leur
// orientation — Facebook en mode story fait autrement osciller l'écran virtuel
// et la fenêtre indéfiniment, jusqu'à l'affichage inutilisable.
const FORMATS = {
  paysage: { width: 1280, height: 800, flex: true, captureOrientation: '' },
  portrait: { width: 800, height: 1280, flex: false, captureOrientation: '@' },
};

function closeMenu() {
  const open = document.querySelector('.menu');
  if (open) open.remove();
}

// ── État des radios & centre de contrôle ───────────────────────────────────

let quick = null; // dernier état connu : { net, volume, ringer, dnd }

/// Indicateurs de la barre : allumé, éteint (estompé), ou alerte (mode avion).
function renderNet(net) {
  const cluster = $('net');
  if (!net) { cluster.hidden = true; return; }
  cluster.hidden = false;
  const wifi = $('netWifi');
  wifi.classList.toggle('off', !net.wifi);
  wifi.classList.toggle('live', net.wifi && net.wifiConnected);
  wifi.title = (net.wifi
    ? (net.wifiConnected ? 'Wi-Fi connecté' : 'Wi-Fi actif, non connecté')
    : 'Wi-Fi désactivé') + ' · cliquer pour basculer';
  $('netBt').classList.toggle('off', !net.bluetooth);
  $('netBt').title = (net.bluetooth ? 'Bluetooth actif' : 'Bluetooth désactivé') + ' · cliquer pour basculer';
  $('netPlane').hidden = !net.airplane;
  $('netDnd').hidden = !quick?.dnd;
}

/// Vrai le temps qu'un ordre parte et revienne. Le sondage périodique ne doit
/// pas écraser entre-temps l'état que l'utilisateur vient de demander.
let quickBusy = false;

async function pollQuick() {
  if (!state.device || document.hidden) return;
  const fresh = await window.aura.quickState().catch(() => null);
  if (!fresh) return;
  quick = fresh;
  renderNet(fresh.net);
}

// ── Sélecteur d'appareils ─────────────────────────────────────────────────

/// Liste les appareils prêts. Appelée au démarrage et à chaque reconnexion :
/// brancher un second téléphone fait apparaître le sélecteur sans redémarrage.
async function refreshDevices() {
  state.devices = (await window.aura.devices().catch(() => [])) || [];
  renderDevice();
}

async function openDeviceMenu() {
  closeMenu();
  await refreshDevices();
  if (state.devices.length < 2) return reconnect();

  const menu = document.createElement('div');
  menu.className = 'menu';

  const head = document.createElement('div');
  head.className = 'menu-head';
  head.textContent = 'Appareils';
  menu.appendChild(head);

  for (const d of state.devices) {
    const entry = document.createElement('button');
    entry.className = `menu-item${d.current ? ' checked' : ''}`;
    const label = document.createElement('span');
    label.textContent = d.model;
    entry.appendChild(label);
    const hint = document.createElement('small');
    hint.textContent = d.current ? 'actif' : d.serial;
    entry.appendChild(hint);
    entry.onclick = async () => {
      closeMenu();
      if (d.current) return;
      toast(`Bascule vers ${d.model}…`);
      const fresh = await window.aura.selectDevice(d.serial).catch((err) => {
        toast(String(err.message || err), true);
        return null;
      });
      if (!fresh) return;
      state.device = fresh.device;
      state.apps = fresh.apps || [];
      state.error = fresh.error;
      state.collectedAt = fresh.collectedAt;
      compute();
      renderAll();
      refreshDevices();
      pollQuick();
      toast(`Appareil actif : ${fresh.device ? fresh.device.model : d.serial}`);
    };
    menu.appendChild(entry);
  }

  document.body.appendChild(menu);
  const box = menu.getBoundingClientRect();
  const r = $('device').getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - box.width - 8))}px`;
  menu.style.top = `${Math.max(8, r.bottom + 6)}px`;
}

/// Une radio met un instant à basculer pour de bon : relire son état trop tôt
/// renverrait celui d'avant, et le bouton clignoterait dans le mauvais sens.
const RELECTURE_RADIO = 1400;

/// Le centre de contrôle : tout ce qu'on ne veut pas entasser dans la barre.
///
/// Le menu s'ouvre sur le dernier état connu, puis se rectifie tout seul : le
/// faire attendre l'aller-retour USB donnait un menu qui met une seconde à
/// apparaître, pour un état qui a rarement changé entre-temps.
async function openControlMenu(x, y) {
  closeMenu();

  const menu = document.createElement('div');
  menu.className = 'menu control';
  // Ce qui reflète le téléphone est repeint sur place ; le reste ne bouge pas.
  const live = document.createElement('div');
  menu.appendChild(live);

  const row = (label) => {
    const r = document.createElement('div');
    r.className = 'control-row';
    const t = document.createElement('span');
    t.className = 'control-label';
    t.textContent = label;
    r.appendChild(t);
    return r;
  };

  const place = () => {
    const box = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - box.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - box.height - 8))}px`;
  };

  // Une bascule doit se voir à l'instant du clic. L'aller-retour USB prend près
  // d'une seconde : refermer le menu pour le rouvrir après coup laissait
  // croire que le clic s'était perdu. On peint donc l'état demandé
  // immédiatement, on marque le bouton en attente, et on rectifie avec ce que
  // le téléphone répond vraiment.
  let attente = null;
  const action = async (clé, optimiste, run, délai = 0) => {
    if (attente) return; // un ordre à la fois : deux se marcheraient dessus
    attente = clé;
    quickBusy = true;
    if (quick) { optimiste(quick); renderNet(quick.net); }
    paint();
    let refusé = false;
    try {
      await run();
    } catch (err) {
      refusé = true;
      toast(messageErreur(err), true);
    }
    if (délai && !refusé) await new Promise((r) => setTimeout(r, délai));
    attente = null;
    quickBusy = false;
    await pollQuick(); // l'appareil reste la source de vérité
    paint();
  };

  // Le volume ne se verrouille pas comme le reste : monter de trois crans, ce
  // sont trois clics de suite, et chacun devait attendre l'aller-retour du
  // précédent. Les crans s'accumulent donc, l'affichage suit au doigt, et un
  // seul ordre part avec le total.
  let volumeEnCours = false;
  let volumeEnAttente = 0;
  const stepVolume = async (delta) => {
    if (!quick?.volume) return;
    const { value, max } = quick.volume;
    quick.volume = { ...quick.volume, value: Math.max(0, Math.min(max, value + delta)) };
    volumeEnAttente += delta;
    paint();
    if (volumeEnCours) return; // le tour déjà lancé emportera ce cran-là
    volumeEnCours = true;
    quickBusy = true;
    while (volumeEnAttente) {
      const total = volumeEnAttente;
      volumeEnAttente = 0;
      try {
        await window.aura.setVolume(total);
      } catch (err) {
        toast(messageErreur(err), true);
        volumeEnAttente = 0;
        break;
      }
    }
    volumeEnCours = false;
    quickBusy = false;
    await pollQuick();
    paint();
  };

  /// Un bouton-pastille : allumé, en attente, et cliquable une fois.
  const chip = (label, { on = false, clé = label, optimiste = () => {}, run, délai = 0 }) => {
    const b = document.createElement('button');
    b.className = `chip-toggle${on ? ' on' : ''}${attente === clé ? ' busy' : ''}`;
    b.textContent = label;
    if (attente) b.disabled = true;
    b.onclick = () => action(clé, optimiste, run, délai);
    return b;
  };

  function paint() {
    if (!menu.isConnected) return;
    live.textContent = '';

    // ─ Radios : cliquer bascule, l'état se voit aussi dans la barre.
    if (quick?.net) {
      const radios = row('Connexions');
      radios.classList.add('wrap');
      const radio = (label, champ, nom) => {
        // La cible se fige ici : `optimiste` a déjà modifié `quick` quand
        // `run` s'exécute, et relire l'état à ce moment inverserait l'ordre.
        const cible = !quick.net[champ];
        return chip(label, {
          on: quick.net[champ],
          clé: nom,
          optimiste: (q) => { q.net[champ] = cible; },
          run: () => window.aura.setRadio(nom, cible),
          délai: RELECTURE_RADIO,
        });
      };
      radios.append(
        radio('Wi-Fi', 'wifi', 'wifi'),
        radio('Bluetooth', 'bluetooth', 'bluetooth'),
        radio('Données', 'mobileData', 'data'),
      );
      live.appendChild(radios);
    } else {
      // Sans état lisible, mieux vaut le dire que d'afficher un menu amputé :
      // on saurait sinon ni que les bascules existent, ni pourquoi elles
      // manquent.
      const absent = row('Connexions');
      const note = document.createElement('small');
      note.className = 'control-note';
      // Trois situations différentes, trois phrases : rien n'est plus
      // décourageant qu'« illisible » alors que la lecture est en cours.
      note.textContent = !state.device
        ? 'aucun téléphone connecté'
        : quick
          ? 'état illisible sur cet appareil'
          : 'lecture en cours…';
      absent.appendChild(note);
      live.appendChild(absent);
    }

    // ─ Volume média.
    if (quick?.volume) {
      const vol = row(`Volume média · ${quick.volume.value}/${quick.volume.max}`);
      vol.classList.add('wrap');
      const step = (delta, label) => {
        const b = document.createElement('button');
        b.className = 'chip-toggle';
        b.textContent = label;
        b.onclick = () => stepVolume(delta);
        return b;
      };
      vol.append(step(-1, '−'), step(+1, '+'));
      live.appendChild(vol);
    }

    // ─ Mode de sonnerie : trois segments exclusifs.
    if (quick?.ringer) {
      const ring = row('Sonnerie');
      ring.classList.add('wrap');
      for (const [mode, label] of [['normal', 'Sonnerie'], ['vibrate', 'Vibreur'], ['silent', 'Silencieux']]) {
        ring.appendChild(chip(label, {
          on: quick.ringer === mode,
          clé: `ring-${mode}`,
          optimiste: (q) => { q.ringer = mode; },
          run: () => window.aura.setRinger(mode),
        }));
      }
      live.appendChild(ring);
    }

    // ─ Ne pas déranger.
    if (quick && typeof quick.dnd === 'boolean') {
      const dndRow = row('Ne pas déranger');
      dndRow.classList.add('wrap');
      const cible = !quick.dnd;
      // L'interrupteur des réglages, plutôt qu'une pastille : il glisse, il
      // change de couleur, et le mot à côté lève le dernier doute. La couleur
      // seule ne se lit pas quand on ne sait pas à quoi la comparer.
      const b = document.createElement('button');
      b.className = `switch${quick.dnd ? ' on' : ''}${attente === 'dnd' ? ' busy' : ''}`;
      b.setAttribute('aria-label', `Ne pas déranger — ${quick.dnd ? 'activé' : 'désactivé'}`);
      b.setAttribute('aria-pressed', String(quick.dnd));
      if (attente) b.disabled = true;
      b.onclick = () => action('dnd', (q) => { q.dnd = cible; }, () => window.aura.setDnd(cible));
      const mot = document.createElement('span');
      mot.className = 'control-state';
      mot.textContent = quick.dnd ? 'Activé' : 'Désactivé';
      dndRow.append(b, mot);
      live.appendChild(dndRow);
    }

    place();
  }

  const sep = document.createElement('div');
  sep.className = 'menu-sep';
  menu.appendChild(sep);

  // ─ Actions de fenêtre, anciennement boutons de la barre.
  const item = (label, hint, checked, run) => {
    const entry = document.createElement('button');
    entry.className = `menu-item${checked ? ' checked' : ''}`;
    const l = document.createElement('span');
    l.textContent = label;
    entry.appendChild(l);
    if (hint) {
      const h = document.createElement('small');
      h.textContent = hint;
      entry.appendChild(h);
    }
    entry.onclick = async () => { closeMenu(); await run(); };
    return entry;
  };

  menu.appendChild(item('Réseaux Wi-Fi', 'Voir, rejoindre, oublier', false, () => openPanel('wifi')));
  menu.appendChild(item('Écran du téléphone', 'Recopier l\'écran principal', false, openMirrorFromMenu));
  menu.appendChild(item('Épingler la fenêtre', 'Rester affiché après un clic ailleurs', !!state.settings.pinned,
    async () => {
      state.settings = await window.aura.saveSettings({ pinned: !state.settings.pinned });
      toast(state.settings.pinned ? 'Fenêtre épinglée' : 'Fenêtre libérée');
    }));
  menu.appendChild(item('Réglages', 'Ctrl+,', false, () => openPanel('settings')));

  document.body.appendChild(menu);
  paint();
  // Puis l'état réel, qui arrive une demi-seconde plus tard sans avoir retenu
  // l'ouverture du menu.
  pollQuick().then(paint);
}

async function openAppMenu(app, x, y) {
  closeMenu();
  const override = (await window.aura.overrideFor(app.package).catch(() => ({}))) || {};
  const fixed = override.flex === false;
  const wide = override.flex === true;

  const items = [
    { label: 'Ouvrir en paysage', hint: '1280 × 800, suit la fenêtre', run: () => launch(app.package, FORMATS.paysage) },
    { label: 'Ouvrir en portrait fixe', hint: '800 × 1280, rotation verrouillée', run: () => launch(app.package, FORMATS.portrait) },
    { separator: true },
    {
      label: 'Toujours en portrait fixe',
      checked: fixed,
      hint: 'Contre les bascules paysage/portrait',
      run: () => window.aura.setOverride(app.package, FORMATS.portrait),
    },
    {
      label: 'Toujours en paysage',
      checked: wide,
      run: () => window.aura.setOverride(app.package, FORMATS.paysage),
    },
    {
      label: 'Réglages par défaut',
      hint: Object.keys(override).length ? 'Efface le format mémorisé' : 'Aucun format mémorisé',
      run: () => window.aura.setOverride(app.package, null),
    },
    { separator: true },
    {
      label: isFavorite(app.package) ? 'Retirer des favoris' : 'Épingler aux favoris',
      run: () => toggleFavorite(app.package),
    },
  ];

  const menu = document.createElement('div');
  menu.className = 'menu';

  const head = document.createElement('div');
  head.className = 'menu-head';
  head.textContent = app.name;
  menu.appendChild(head);

  for (const item of items) {
    if (item.separator) {
      const line = document.createElement('div');
      line.className = 'menu-sep';
      menu.appendChild(line);
      continue;
    }
    const entry = document.createElement('button');
    entry.className = `menu-item${item.checked ? ' checked' : ''}`;
    const label = document.createElement('span');
    label.textContent = item.label;
    entry.appendChild(label);
    if (item.hint) {
      const hint = document.createElement('small');
      hint.textContent = item.hint;
      entry.appendChild(hint);
    }
    entry.onclick = async () => {
      closeMenu();
      await item.run();
    };
    menu.appendChild(entry);
  }

  document.body.appendChild(menu);

  // Le menu ne doit pas déborder de la fenêtre, qui est petite.
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - box.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - box.height - 8))}px`;
}

// Un clic ailleurs referme les menus. « Ailleurs » se juge sur l'élément
// cliqué — encore faut-il qu'il soit toujours dans la page : un bouton qui se
// redessine sous le clic (les bascules du centre de contrôle) est détaché
// avant que l'évènement ne remonte jusqu'ici, n'a donc plus d'ancêtre `.menu`,
// et passait pour un clic extérieur. Le menu se refermait sur-le-champ.
document.addEventListener('click', (e) => {
  if (!e.target.isConnected) return;
  if (!e.target.closest('.menu')) closeMenu();
});
window.addEventListener('blur', closeMenu);

// ── Raccourci ───────────────────────────────────────────────────────────────

// Traduit un événement clavier en accélérateur Electron. Retourne rien quand la
// combinaison n'en est pas une : touche seule, modificateur seul, ou AltGr, que
// X11 traite comme une composition et qu'aucun raccourci global ne peut prendre.
function toAccelerator(e) {
  if (e.getModifierState('AltGraph')) return null;

  const modifiers = [];
  // L'ordre suit l'usage : Ctrl, Alt, Super, puis Shift.
  if (e.ctrlKey) modifiers.push('Ctrl');
  if (e.altKey) modifiers.push('Alt');
  if (e.metaKey) modifiers.push('Super');
  if (e.shiftKey) modifiers.push('Shift');
  if (!modifiers.length) return null;

  const code = e.code || '';
  let key = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^F\d{1,2}$/.test(code)) key = code;
  else if (code === 'Space') key = 'Space';
  else if (code === 'Enter') key = 'Return';
  else if (['Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown'].includes(code)) key = code;
  else if (/^Arrow(Up|Down|Left|Right)$/.test(code)) key = code.slice(5);
  if (!key) return null;

  return [...modifiers, key].join('+');
}

// Libellé lisible : « Ctrl+Alt+Space » se lit mieux « Ctrl Alt Espace ».
function prettyHotkey(accelerator) {
  if (!accelerator) return '';
  return accelerator
    .split('+')
    .map((part) => ({ Control: 'Ctrl', CommandOrControl: 'Ctrl', Space: 'Espace', Return: 'Entrée', Super: 'Super' }[part] || part))
    .join(' ');
}

async function applyHotkey(accelerator) {
  const saved = await window.aura.saveSettings({ hotkey: accelerator });
  state.settings = saved;
  const result = saved.hotkeyResult;
  $('hotkeyHint').textContent = prettyHotkey(saved.hotkey);

  if (result && result.refused) {
    toast(
      result.hotkey
        ? `${prettyHotkey(accelerator)} est indisponible — ${prettyHotkey(result.hotkey)} pris à la place`
        : 'Aucun raccourci n’a pu être enregistré',
      true
    );
  } else {
    toast(`Raccourci : ${prettyHotkey(saved.hotkey)}`);
  }
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function launch(pkg, once = null, numero = null, url = null) {
  if (pkg === LIEN || url) {
    try {
      await window.aura.sendUrl(url);
      toast('Lien ouvert sur le téléphone');
    } catch (err) {
      toast(messageErreur(err), true);
    }
    return;
  }

  if (pkg === DIAL || numero) {
    toast('Ouverture du composeur…');
    try {
      const fait = await window.aura.dial(numero);
      if (!fait || !fait.ok) toast("Le composeur n'a pas répondu", true);
    } catch (err) {
      toast(messageErreur(err), true);
    }
    return;
  }

  const app = state.apps.find((a) => a.package === pkg);
  try {
    await window.aura.launch(pkg, once);
    toast(`${app ? app.name : pkg} s'ouvre…`);
  } catch (err) {
    toast(messageErreur(err), true);
  }
}

// ── Appel en cours ──────────────────────────────────────────────────────────

const ETATS = {
  RINGING: 'Appel entrant',
  DIALING: 'Appel en cours…',
  CONNECTING: 'Connexion…',
  ACTIVE: 'En communication',
  ON_HOLD: 'En attente',
};

function renderCall() {
  const banner = $('call');
  const call = state.call;

  if (!call || !ETATS[call.state]) {
    banner.hidden = true;
    fit();
    return;
  }

  const sonne = call.state === 'RINGING';
  banner.hidden = false;
  banner.classList.toggle('active', !sonne);
  $('callState').textContent = ETATS[call.state];

  // Android masque le numéro dans `dumpsys telecom`. Le nom de l'appelant, en
  // revanche, est dans la notification de l'appel : on va le chercher là.
  const notif = state.notifications.find((n) => n.category === 'call');
  $('callWho').textContent = notif ? [notif.title, notif.text].filter(Boolean).join(' — ') : 'Numéro masqué par Android';

  $('callTake').hidden = !sonne;
  $('callDrop').textContent = sonne ? 'Refuser' : 'Raccrocher';
  fit();
}

async function toggleFavorite(pkg) {
  state.settings.favorites = await window.aura.toggleFavorite(pkg);
  // Épingler depuis la recherche doit se voir : on garde la liste ouverte, mais
  // le dock reflète immédiatement le changement quand on la referme.
  if (state.mode === 'dock') compute();
  renderStage();
  toast(isFavorite(pkg) ? 'Épinglé aux favoris' : 'Retiré des favoris');
}

async function refreshApps() {
  if (state.refreshing) return;
  state.refreshing = true;
  toast('Inventaire en cours — une vingtaine de secondes…');
  try {
    const fresh = await window.aura.refreshApps();
    state.apps = fresh.apps;
    state.collectedAt = fresh.collectedAt;
    state.error = null;
    compute();
    renderAll();
    toast(`${fresh.apps.length} applications trouvées`);
  } catch (err) {
    toast(messageErreur(err), true);
  } finally {
    state.refreshing = false;
  }
}

async function reconnect() {
  const fresh = await window.aura.refreshDevice();
  const before = JSON.stringify([state.device, state.error, state.apps.length]);

  state.device = fresh.device;
  state.error = fresh.error;
  state.apps = fresh.apps || [];
  state.collectedAt = fresh.collectedAt;

  // Le sondage passe ici toutes les minutes : reconstruire l'interface à chaque
  // fois ferait clignoter le dock et perdrait la sélection pour rien.
  if (JSON.stringify([state.device, state.error, state.apps.length]) === before) return;
  compute();
  renderAll();
  pollQuick();
  refreshDevices();
}

// Signature du dernier ensemble de notifications connu.
let notifSignature = null;

// Sondage économe : la liste des clés pèse deux cents octets et répond en
// 0,05 s, là où le dump complet fait plus d'un mégaoctet et coûte 0,3 s. On ne
// demande le détail que si quelque chose a changé — ou si le volet est ouvert.
async function pollNotifications() {
  if (!state.device) return;
  const keys = await window.aura.notificationKeys().catch(() => null);
  if (!keys) return;

  const signature = keys.join('\n');
  if (signature === notifSignature && !panelOpen()) return;
  notifSignature = signature;
  await loadNotifications();
}

async function loadNotifications() {
  if (!state.device) return;
  try {
    state.notifications = await window.aura.notifications();
    renderNotifications();
  } catch (_) { /* l'appareil a pu être débranché */ }
}

/// Le message d'une erreur, débarrassé de l'emballage d'Electron.
///
/// Une exception levée dans le processus principal revient ici sous la forme
/// « Error invoking remote method 'wifi:join': Error: … ». La phrase utile est
/// à la fin ; le reste ne dit rien à personne et occupe toute la largeur.
function messageErreur(err) {
  const brut = String((err && err.message) || err || '');
  return brut.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(?:Uncaught )?Error:\s*/, '').trim() || 'échec inattendu';
}

let toastTimer = null;
function toast(message, isError = false, onClick = null) {
  const el = $('toast');
  el.onclick = onClick
    ? () => { el.hidden = true; clearTimeout(toastTimer); onClick(); }
    : null;
  el.textContent = message;
  el.className = `toast${isError ? ' error' : ''}${onClick ? ' clickable' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  // Un message sur lequel on peut cliquer doit laisser le temps de le faire.
  toastTimer = setTimeout(() => { el.hidden = true; }, onClick ? 12000 : isError ? 6000 : 2600);
}

function select(index, scroll = true) {
  const max = state.results.length;
  if (!max) return;
  state.selected = ((index % max) + max) % max;
  const selector = state.mode === 'hits' ? '.hit' : '.fav';
  document.querySelectorAll(selector).forEach((el, i) => el.classList.toggle('sel', i === state.selected));
  if (scroll) {
    const el = document.querySelector(`${selector}.sel`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }
}

// Hauteur utile du contenu, pour que la fenêtre s'ajuste au lieu de laisser du
// vide sous les favoris. Les parties fixes sont mesurées, la scène est le seul
// élément dont la hauteur dépend de ce qu'on affiche.
function fit() {
  requestAnimationFrame(() => {
    // Un volet ouvert occupe toute la hauteur : il lui faut de la place pour
    // que la liste se lise, sans quoi on ferait défiler trois lignes.
    if (panelOpen()) return window.aura.fit(460);

    const shell = document.querySelector('.shell');
    const dock = $('dock');
    const hits = $('hits');
    const empty = $('empty');

    const inner = !dock.hidden ? dock : (!hits.hidden ? hits : empty);
    const content = inner === empty ? 160 : inner.scrollHeight;

    const style = getComputedStyle(shell);
    const gap = parseFloat(style.rowGap || style.gap || 0);

    // Tout ce qui entoure la scène est mesuré, plutôt qu'énuméré : la liste
    // figée d'autrefois (barre, recherche, pied) ignorait le bandeau d'appel
    // et la bande d'envois, et la fenêtre restait trop courte — la scène était
    // alors écrasée à quelques pixels sous le reste du contenu.
    let frame = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    let rangs = 0;
    for (const enfant of shell.children) {
      // Volets, voiles et messages flottent au-dessus : ils ne prennent pas de
      // place dans la colonne.
      const pose = getComputedStyle(enfant).position;
      if (pose === 'absolute' || pose === 'fixed') continue;
      if (enfant.hidden || getComputedStyle(enfant).display === 'none') continue;
      rangs++;
      if (!enfant.contains(inner)) frame += enfant.offsetHeight;
    }
    frame += gap * Math.max(0, rangs - 1);

    // 20 px pour les marges du corps ; en liste, 10 de plus pour qu'une barre
    // de défilement n'apparaisse pas sur un demi-pixel d'écart.
    window.aura.fit(frame + content + (inner === dock ? 20 : 30));
  });
}

function renderAll() {
  renderDevice();
  renderStage();
  renderSessions();
  renderNotifications();
  fit();
}

// ── Volets ──────────────────────────────────────────────────────────────────

function openPanel(which) {
  for (const [nom, id] of [['notifs', 'panelNotifs'], ['settings', 'panelSettings'], ['wifi', 'panelWifi']]) {
    $(id).hidden = which !== nom;
  }
  $('btnNotifs').classList.toggle('active', which === 'notifs');
  if (which === 'notifs') pollNotifications();
  if (which === 'settings') renderSettings();
  if (which === 'wifi') openWifi();
  fit();
}

const panelOpen = () =>
  ['panelNotifs', 'panelSettings', 'panelWifi'].some((id) => !$(id).hidden);

// ── Pont bureau → téléphone ─────────────────────────────────────────────────
//
// Déposer un fichier sur le widget l'envoie dans les Téléchargements du
// téléphone ; un .apk demande d'abord ce qu'on veut en faire. Le glisser-
// déposer interne — réordonner les favoris — ne porte que du texte : c'est la
// présence du type « Files » qui distingue les deux, jamais la cible du survol.

const transferts = new Map(); // id → { nom, état, envoyé, total, install, message }

function estFichierExterne(e) {
  return [...(e.dataTransfer?.types || [])].includes('Files');
}

const octets = (n) => {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} ko`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} Mo`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} Go`;
};

function renderTransfers() {
  const zone = $('transfers');
  zone.textContent = '';
  const liste = [...transferts.values()];
  zone.hidden = !liste.length;
  if (!liste.length) return fit();

  for (const t of liste) {
    const ligne = document.createElement('div');
    ligne.className = `transfer ${t.état === 'échec' ? 'failed' : t.état === 'fini' ? 'done' : ''}`;

    const textes = document.createElement('div');
    textes.className = 'transfer-texts';
    const nom = document.createElement('div');
    nom.className = 'transfer-name';
    nom.textContent = t.nom;
    const état = document.createElement('div');
    état.className = 'transfer-state';
    état.textContent =
      t.état === 'échec' ? t.message
      : t.état === 'fini' ? t.message
      : t.install ? 'Installation…'
      : t.total ? `${octets(t.envoyé)} / ${octets(t.total)}`
      : 'Envoi…';
    textes.append(nom, état);
    ligne.appendChild(textes);

    // Une barre pleine à 100 % dirait « fini » avant que ce le soit : tant que
    // la taille totale est inconnue, on montre un va-et-vient.
    const jauge = document.createElement('div');
    jauge.className = `gauge${t.total ? '' : ' indeterminate'}`;
    const part = document.createElement('i');
    if (t.total) part.style.width = `${Math.round((100 * t.envoyé) / t.total)}%`;
    jauge.appendChild(part);
    if (t.état === 'en cours') ligne.appendChild(jauge);

    zone.appendChild(ligne);
  }
  fit();
}

function onTransfer(info) {
  const connu = transferts.get(info.id) || {};
  transferts.set(info.id, { ...connu, ...info });
  renderTransfers();
  if (info.état === 'fini' || info.état === 'échec') {
    if (info.état === 'échec') toast(`${info.nom} : ${info.message}`, true);
    // La ligne reste un instant pour être lue, puis s'efface d'elle-même.
    setTimeout(() => { transferts.delete(info.id); renderTransfers(); }, info.état === 'échec' ? 8000 : 3500);
  }
}

/// Envoie une liste de chemins, après avoir tranché le sort des .apk.
async function envoyer(chemins) {
  if (!state.device) return toast('Aucun téléphone connecté', true);
  const apks = chemins.filter((c) => /\.apk$/i.test(c));
  const autres = chemins.filter((c) => !/\.apk$/i.test(c));

  if (autres.length) {
    window.aura.sendFiles(autres.map((path) => ({ path, action: 'push' }))).catch((err) => toast(messageErreur(err), true));
  }
  if (!apks.length) return;

  const choix = await demanderApk(apks);
  if (!choix) return;
  window.aura
    .sendFiles(apks.map((path) => ({ path, action: choix })))
    .catch((err) => toast(messageErreur(err), true));
}

/// Installer ou simplement copier ? Installer une application est un acte qui
/// se demande — le fichier vient d'être glissé, l'intention n'est pas dite.
function demanderApk(apks) {
  return new Promise((resolve) => {
    const voile = $('askApk');
    $('askTitle').textContent = apks.length > 1 ? `${apks.length} applications Android` : 'Application Android';
    $('askText').textContent = apks.map((c) => c.split('/').pop()).join(', ');
    voile.hidden = false;

    const fermer = (valeur) => {
      voile.hidden = true;
      document.removeEventListener('keydown', surTouche, true);
      resolve(valeur);
    };
    const surTouche = (e) => { if (e.key === 'Escape') { e.stopPropagation(); fermer(null); } };
    document.addEventListener('keydown', surTouche, true);
    $('askInstall').onclick = () => fermer('install');
    $('askCopy').onclick = () => fermer('push');
    $('askCancel').onclick = () => fermer(null);
    $('askInstall').focus();
  });
}

// Un compteur, et non un booléen : `dragleave` part aussi quand le pointeur
// passe d'un élément à son voisin, et le voile clignoterait à chaque frontière.
let survols = 0;
// `dragover` bat en continu tant qu'un fichier survole la fenêtre. Son silence
// est donc le signe le plus sûr que le survol est fini — plus sûr que
// `dragleave`, qui se perd quand le pointeur quitte la fenêtre trop vite ou
// que le dépôt se termine chez le voisin. Sans ce garde-fou, le voile reste
// affiché indéfiniment, et comme il ne prend pas les clics, rien ne le chasse.
let veilleVoile = null;

function montrerVoile(afficher) {
  const voile = $('dropzone');
  if (afficher) {
    $('dropzoneText').textContent = state.device
      ? 'Déposer pour envoyer au téléphone'
      : 'Aucun téléphone connecté';
    voile.classList.toggle('refuse', !state.device);
  } else {
    survols = 0;
  }
  voile.hidden = !afficher;
  clearTimeout(veilleVoile);
  veilleVoile = afficher ? setTimeout(() => montrerVoile(false), 600) : null;
}

document.addEventListener('dragenter', (e) => {
  if (!estFichierExterne(e)) return;
  e.preventDefault();
  survols++;
  montrerVoile(true);
});
document.addEventListener('dragover', (e) => {
  if (!estFichierExterne(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = state.device ? 'copy' : 'none';
  montrerVoile(true); // réarme la veille
});
document.addEventListener('dragleave', (e) => {
  if (!estFichierExterne(e)) return;
  survols = Math.max(0, survols - 1);
  if (!survols) montrerVoile(false);
});
document.addEventListener('dragend', () => montrerVoile(false));
document.addEventListener('drop', (e) => {
  if (!estFichierExterne(e)) return;
  e.preventDefault();
  montrerVoile(false);
  const chemins = [...e.dataTransfer.files].map((f) => window.aura.pathForFile(f)).filter(Boolean);
  if (!chemins.length) return toast('Ce dépôt ne contient aucun fichier lisible', true);
  envoyer(chemins);
});

/// Ce qui ressemble à une adresse : de quoi proposer l'envoi au téléphone sans
/// exiger le « https:// » que personne ne tape.
const ADRESSE = /^(?:(?:https?|tel|mailto|sms|geo|market):\S+|(?:www\.)?[\w-]+(?:\.[\w-]+)+(?:[/?#]\S*)?)$/i;

function adresseDe(texte) {
  const propre = String(texte || '').trim();
  if (!ADRESSE.test(propre)) return null;
  return /^[a-z]+:/i.test(propre) ? propre : `https://${propre}`;
}

// ── Réseaux Wi-Fi ───────────────────────────────────────────────────────────
//
// Ce que le téléphone accepte d'un ordinateur branché en USB s'arrête à la
// suggestion : Android exige une tape sur son propre écran avant de rejoindre
// un réseau proposé de l'extérieur (voir `device.js`). L'interface le dit
// franchement plutôt que de laisser croire à une connexion qui n'arrive pas.

let wifi = { status: null, scan: [], saved: [], chargement: false, ouvert: null };

/// Quatre barreaux d'antenne, dessinés en SVG.
function antenne(bars) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 12');
  svg.classList.add('bars');
  for (let i = 0; i < 4; i++) {
    const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    r.setAttribute('x', String(i * 4));
    r.setAttribute('y', String(9 - i * 3));
    r.setAttribute('width', '2.6');
    r.setAttribute('height', String(3 + i * 3));
    r.setAttribute('rx', '1');
    r.classList.toggle('off', i >= bars);
    svg.appendChild(r);
  }
  return svg;
}

const CADENAS =
  'M7 10V7.5a5 5 0 0 1 10 0V10M5.5 10h13v9h-13z';

function cadenas() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.classList.add('lock');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', CADENAS);
  svg.appendChild(p);
  return svg;
}

async function openWifi(rescan = true) {
  wifi.chargement = true;
  renderWifi();
  const data = await window.aura.wifiList(rescan).catch((err) => {
    toast(messageErreur(err), true);
    return null;
  });
  wifi.chargement = false;
  if (data) Object.assign(wifi, data);
  renderWifi();
}

function renderWifi() {
  const body = $('wifiBody');
  body.textContent = '';

  const ligneÉtat = document.createElement('div');
  ligneÉtat.className = 'wifi-status';
  const s = wifi.status;
  ligneÉtat.textContent = !s
    ? 'État inconnu'
    : !s.enabled
      ? 'Wi-Fi désactivé sur le téléphone'
      : s.connected
        ? `Connecté à ${s.ssid || 'un réseau'}`
        : 'Activé, connecté à aucun réseau';
  body.appendChild(ligneÉtat);

  // Le Wi-Fi éteint, il n'y a rien à chercher : on propose de l'allumer.
  if (s && !s.enabled) {
    const allumer = document.createElement('button');
    allumer.className = 'ghost wide';
    allumer.textContent = 'Activer le Wi-Fi';
    allumer.onclick = async () => {
      try {
        await window.aura.setRadio('wifi', true);
        toast('Wi-Fi activé');
        setTimeout(() => openWifi(true), RELECTURE_RADIO);
      } catch (err) { toast(messageErreur(err), true); }
    };
    body.appendChild(allumer);
  }

  if (wifi.chargement) {
    const attente = document.createElement('div');
    attente.className = 'wifi-note';
    attente.textContent = 'Recherche des réseaux…';
    body.appendChild(attente);
  }

  const enregistrés = new Map(wifi.saved.map((r) => [r.ssid, r]));

  for (const réseau of wifi.scan) {
    body.appendChild(ligneRéseau(réseau, enregistrés.get(réseau.ssid)));
  }

  if (!wifi.chargement && !wifi.scan.length) {
    const vide = document.createElement('div');
    vide.className = 'wifi-note';
    vide.textContent = 'Aucun réseau capté.';
    body.appendChild(vide);
  }

  // ─ Réseau caché : le seul moyen d'atteindre ce qui ne se diffuse pas.
  const caché = document.createElement('button');
  caché.className = 'ghost wide';
  caché.textContent = wifi.ouvert === 'caché' ? 'Annuler' : 'Rejoindre un réseau masqué…';
  caché.onclick = () => { wifi.ouvert = wifi.ouvert === 'caché' ? null : 'caché'; renderWifi(); };
  body.appendChild(caché);
  if (wifi.ouvert === 'caché') body.appendChild(formulaire(null));

  // ─ Les réseaux enregistrés qu'on ne capte pas ici : utile pour faire le
  //   ménage dans une liste qui s'allonge d'année en année.
  const absents = wifi.saved.filter((r) => !wifi.scan.some((v) => v.ssid === r.ssid));
  if (absents.length) {
    const titre = document.createElement('div');
    titre.className = 'settings-group';
    titre.textContent = `Enregistrés, hors de portée (${absents.length})`;
    body.appendChild(titre);
    for (const r of absents) body.appendChild(ligneEnregistré(r));
  }

  // ─ La voie de secours, toujours visible : les réglages du téléphone.
  const note = document.createElement('div');
  note.className = 'wifi-note';
  note.textContent =
    'Android demande une validation sur le téléphone avant de rejoindre un réseau proposé depuis l’ordinateur. ' +
    'Pour un portail captif ou un réseau d’entreprise, passez par ses réglages.';
  body.appendChild(note);

  const réglages = document.createElement('button');
  réglages.className = 'ghost wide';
  réglages.textContent = 'Ouvrir les réglages Wi-Fi du téléphone';
  réglages.onclick = async () => {
    try {
      await window.aura.wifiSettings();
      await window.aura.openMirror();
      toast('Réglages Wi-Fi ouverts sur le téléphone');
    } catch (err) { toast(messageErreur(err), true); }
  };
  body.appendChild(réglages);
}

function ligneRéseau(réseau, enregistré) {
  const nom = réseau.ssid || `Réseau masqué (${réseau.bssid})`;
  const bloc = document.createElement('div');
  bloc.className = 'wifi-net';

  const tête = document.createElement('button');
  tête.className = 'wifi-head';
  tête.appendChild(antenne(réseau.bars));

  const textes = document.createElement('div');
  textes.className = 'wifi-texts';
  const titre = document.createElement('div');
  titre.className = 'wifi-ssid';
  titre.textContent = nom;
  const détail = document.createElement('div');
  détail.className = 'wifi-meta';
  const bouts = [réseau.band, `${réseau.rssi} dBm`];
  if (réseau.security === 'open') bouts.push('ouvert');
  else if (réseau.security === 'eap') bouts.push('entreprise');
  else bouts.push(réseau.security.toUpperCase());
  if (enregistré) bouts.push('enregistré');
  if (wifi.status?.connected && wifi.status.ssid === réseau.ssid) bouts.push('connecté');
  détail.textContent = bouts.join(' · ');
  textes.append(titre, détail);
  tête.appendChild(textes);
  if (réseau.security !== 'open') tête.appendChild(cadenas());

  const clé = réseau.ssid || réseau.bssid;
  tête.onclick = () => { wifi.ouvert = wifi.ouvert === clé ? null : clé; renderWifi(); };
  bloc.appendChild(tête);

  if (wifi.ouvert === clé) {
    // Un réseau d'entreprise demande certificat et identifiant : la suggestion
    // shell n'en est pas capable, autant le dire tout de suite.
    if (réseau.security === 'eap') {
      const note = document.createElement('div');
      note.className = 'wifi-note';
      note.textContent = "Réseau d'entreprise : à rejoindre depuis les réglages du téléphone.";
      bloc.appendChild(note);
    } else {
      bloc.appendChild(formulaire(réseau));
    }
    if (enregistré) bloc.appendChild(boutonOublier(enregistré));
  }
  return bloc;
}

function ligneEnregistré(r) {
  const bloc = document.createElement('div');
  bloc.className = 'wifi-net faint';
  const tête = document.createElement('button');
  tête.className = 'wifi-head';
  const textes = document.createElement('div');
  textes.className = 'wifi-texts';
  const titre = document.createElement('div');
  titre.className = 'wifi-ssid';
  titre.textContent = r.ssid;
  const détail = document.createElement('div');
  détail.className = 'wifi-meta';
  détail.textContent = r.security;
  textes.append(titre, détail);
  tête.appendChild(textes);
  const clé = `saved:${r.id}`;
  tête.onclick = () => { wifi.ouvert = wifi.ouvert === clé ? null : clé; renderWifi(); };
  bloc.appendChild(tête);
  if (wifi.ouvert === clé) bloc.appendChild(boutonOublier(r));
  return bloc;
}

function boutonOublier(r) {
  const b = document.createElement('button');
  b.className = 'ghost danger wide';
  b.textContent = `Oublier « ${r.ssid} »`;
  b.onclick = async () => {
    b.disabled = true;
    try {
      await window.aura.wifiForget(r.id);
      toast(`${r.ssid} oublié`);
      wifi.ouvert = null;
      await openWifi(false);
    } catch (err) {
      toast(messageErreur(err), true);
      b.disabled = false;
    }
  };
  return b;
}

/// Le formulaire de connexion. `réseau` nul = réseau masqué, dont il faut
/// saisir le nom soi-même.
function formulaire(réseau) {
  const form = document.createElement('form');
  form.className = 'wifi-form';

  const champSsid = document.createElement('input');
  champSsid.type = 'text';
  champSsid.placeholder = 'Nom du réseau (SSID)';
  champSsid.autocomplete = 'off';
  champSsid.spellcheck = false;
  if (réseau) champSsid.value = réseau.ssid;

  const sécurité = document.createElement('select');
  for (const [valeur, libellé] of [['wpa2', 'WPA/WPA2'], ['wpa3', 'WPA3'], ['open', 'Ouvert'], ['owe', 'Ouvert renforcé (OWE)']]) {
    const o = document.createElement('option');
    o.value = valeur;
    o.textContent = libellé;
    sécurité.appendChild(o);
  }
  sécurité.value = réseau ? réseau.security : 'wpa2';

  const motDePasse = document.createElement('input');
  motDePasse.type = 'password';
  motDePasse.placeholder = 'Mot de passe';
  motDePasse.autocomplete = 'off';

  const voir = document.createElement('button');
  voir.type = 'button';
  voir.className = 'ghost';
  voir.textContent = 'Voir';
  voir.onclick = () => {
    motDePasse.type = motDePasse.type === 'password' ? 'text' : 'password';
    voir.textContent = motDePasse.type === 'password' ? 'Voir' : 'Cacher';
  };

  const clé = document.createElement('div');
  clé.className = 'wifi-row';
  clé.append(motDePasse, voir);

  const majClé = () => { clé.hidden = sécurité.value === 'open' || sécurité.value === 'owe'; };
  sécurité.onchange = majClé;
  majClé();

  const envoyer = document.createElement('button');
  envoyer.type = 'submit';
  envoyer.className = 'ghost primary wide';
  envoyer.textContent = 'Proposer au téléphone';

  // Un réseau capté sans son nom (trop loin, ou volontairement discret) se
  // traite comme un réseau masqué : c'est à l'utilisateur de donner le SSID.
  const àNommer = !réseau || réseau.hidden;
  if (àNommer) form.append(champSsid, sécurité, clé, envoyer);
  else form.append(sécurité, clé, envoyer);

  form.onsubmit = async (e) => {
    e.preventDefault();
    envoyer.disabled = true;
    envoyer.textContent = 'Envoi…';
    try {
      await window.aura.wifiJoin({
        ssid: champSsid.value,
        security: sécurité.value,
        passphrase: motDePasse.value,
        hidden: àNommer,
      });
      // Le mot de passe ne traîne pas dans la page une fois parti.
      motDePasse.value = '';
      wifi.ouvert = null;
      toast('Proposé — validez la demande sur le téléphone', false, () => window.aura.openMirror());
      await openWifi(false);
    } catch (err) {
      toast(messageErreur(err), true);
      envoyer.disabled = false;
      envoyer.textContent = 'Proposer au téléphone';
    }
  };
  return form;
}

// ── Fond ────────────────────────────────────────────────────────────────────

// Le fond reçu est une photographie de l'écran entier. On la place derrière la
// fenêtre, décalée de sa position : le flou suit alors ce qui se trouve
// réellement dessous.
function paintWallpaper(frame) {
  const holder = $('wallpaper');
  holder.textContent = '';
  if (!state.settings.blurWallpaper) { holder.classList.remove('on'); return; }

  const img = new Image();
  img.onload = () => {
    const ratio = 1 / frame.scale;
    // La marge cache les bords non flous de l'image.
    const bleed = 60;
    img.style.width = `${img.naturalWidth * ratio + bleed * 2}px`;
    img.style.left = `${-(window.screenX - frame.display.x) - bleed}px`;
    img.style.top = `${-(window.screenY - frame.display.y) - bleed}px`;
    holder.classList.add('on');
  };
  img.src = frame.image;
  holder.appendChild(img);
}

// ── Démarrage ───────────────────────────────────────────────────────────────

async function boot() {
  const data = await window.aura.bootstrap();
  state.settings = data.settings;
  state.device = data.device;
  state.engine = data.engine;
  state.error = data.error;
  state.apps = data.apps || [];
  state.collectedAt = data.collectedAt;
  state.version = data.version;
  state.sessions = data.sessions || [];

  $('hotkeyHint').textContent = prettyHotkey(state.settings.hotkey);
  if (data.hotkeyResult && data.hotkeyResult.refused) {
    toast(
      data.hotkeyResult.hotkey
        ? `Raccourci remplacé par ${prettyHotkey(data.hotkeyResult.hotkey)}`
        : 'Aucun raccourci global disponible',
      true
    );
  }

  const install = await window.aura.engineTarget().catch(() => null);
  if (install) {
    state.installTarget = install.target;
    state.installVersion = install.version;
    state.installSize = install.megabytes;
  }

  compute();
  renderAll();
  pollNotifications();
  pollQuick();
  refreshDevices();
  window.aura.callState().then((call) => { state.call = call; renderCall(); }).catch(() => {});

  // L'inventaire n'existe pas encore au tout premier lancement : on le
  // construit sans rien demander, l'attente est expliquée par le message.
  if (state.device && !state.apps.length) refreshApps();
}

// Barre supérieure
$('btnClose').onclick = () => window.aura.hide();
$('btnNotifs').onclick = () => openPanel(panelOpen() && !$('panelNotifs').hidden ? null : 'notifs');
$('btnCloseNotifs').onclick = () => openPanel(null);
$('btnCloseSettings').onclick = () => openPanel(null);
$('btnCloseWifi').onclick = () => openPanel(null);
$('btnWifiScan').onclick = () => openWifi(true);
$('btnControl').onclick = (e) => {
  // Sans stopPropagation, ce même clic remonte jusqu'à l'écouteur global qui
  // referme les menus : le centre de contrôle serait refermé à l'instant même
  // où il s'ouvre.
  e.stopPropagation();
  const r = e.currentTarget.getBoundingClientRect();
  openControlMenu(r.right - 230, r.bottom + 6);
};

// Un indicateur se clique pour ce qu'il montre : le Wi-Fi bascule le Wi-Fi.
// Faire ouvrir le centre de contrôle à tous rendait ces icônes indiscernables
// du menu ⋯. Les indicateurs sans bascule directe (mode avion) y renvoient
// encore, comme le fond du groupe.
const RADIO_PAR_ICONE = { netWifi: 'wifi', netBt: 'bluetooth' };

$('net').onclick = async (e) => {
  e.stopPropagation();
  const cible = e.target.closest('.net-item');
  const radio = cible ? RADIO_PAR_ICONE[cible.id] : null;

  if (radio && quick?.net) {
    const champ = radio === 'wifi' ? 'wifi' : 'bluetooth';
    const voulu = !quick.net[champ];
    // L'icône prend tout de suite l'état demandé — sans quoi rien ne distingue
    // un clic pris en compte d'un clic perdu — et se rectifie au retour.
    quickBusy = true;
    quick.net[champ] = voulu;
    renderNet(quick.net);
    cible.classList.add('busy');
    try {
      await window.aura.setRadio(radio, voulu);
    } catch (err) {
      toast(messageErreur(err), true);
    }
    cible.classList.remove('busy');
    quickBusy = false;
    // La radio met un instant à basculer pour de bon : relire trop tôt
    // renverrait l'état d'avant.
    setTimeout(pollQuick, RELECTURE_RADIO);
    return;
  }

  if (cible && cible.id === 'netDnd' && typeof quick?.dnd === 'boolean') {
    quickBusy = true;
    try { await window.aura.setDnd(!quick.dnd); } catch (err) { toast(messageErreur(err), true); }
    quickBusy = false;
    return pollQuick();
  }

  const r = e.currentTarget.getBoundingClientRect();
  openControlMenu(r.left, r.bottom + 6);
};
$('btnShade').onclick = () => { window.aura.openShade(); toast('Volet ouvert sur le téléphone'); };
$('btnClearAll').onclick = () => dismissAll();
// Un seul appareil : le pilote relance la connexion. Plusieurs : il ouvre le
// sélecteur — le second téléphone ne doit pas être un invisible.
$('device').onclick = () => ((state.devices || []).length > 1 ? openDeviceMenu() : reconnect());

// L'épinglage vit désormais dans le centre de contrôle (menu ⋯).

// Recherche
$('query').addEventListener('input', (e) => {
  state.query = e.target.value;
  compute();
  renderStage();
});

// Clavier
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (document.querySelector('.menu')) return closeMenu();
    if (panelOpen()) return openPanel(null);
    if (state.query) {
      state.query = '';
      $('query').value = '';
      compute();
      renderStage();
      return;
    }
    return window.aura.hide();
  }

  if (e.key === 'ArrowDown') { e.preventDefault(); return select(state.selected + columns()); }
  if (e.key === 'ArrowUp') { e.preventDefault(); return select(state.selected - columns()); }
  // Dans le dock, les flèches horizontales naviguent ; en recherche, elles
  // doivent rester au service du curseur de texte.
  const textCursor = e.target.id === 'query' && state.query.length > 0;
  if (e.key === 'ArrowRight' && !textCursor) { e.preventDefault(); return select(state.selected + 1); }
  if (e.key === 'ArrowLeft' && !textCursor) { e.preventDefault(); return select(state.selected - 1); }
  if (e.key === 'Tab') { e.preventDefault(); return select(state.selected + (e.shiftKey ? -1 : 1)); }

  if (e.key === 'Enter') {
    const app = state.results[state.selected];
    // Le numéro et l'adresse voyagent avec l'entrée : sans eux, « Appeler »
    // ouvrait le composeur vide, et « Ouvrir » n'aurait rien eu à ouvrir.
    if (app) launch(app.package, null, app.dial, app.url);
    return;
  }
  if (e.key === 'd' && e.ctrlKey) {
    e.preventDefault();
    const app = state.results[state.selected];
    if (app) toggleFavorite(app.package);
    return;
  }
  if (e.key === 'r' && e.ctrlKey) { e.preventDefault(); return refreshApps(); }
  if (e.key === 'n' && e.ctrlKey) { e.preventDefault(); return openPanel('notifs'); }
  if (e.key === ',' && e.ctrlKey) { e.preventDefault(); return openPanel('settings'); }

  // Toute frappe imprimable ramène au champ de recherche : le lanceur se pilote
  // sans jamais viser la barre à la souris.
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && e.target.id !== 'query' && !panelOpen()) {
    $('query').focus();
  }
});

// Nombre de colonnes réellement affichées, pour que ↑ et ↓ tombent juste.
// Nombre de colonnes du dock, pour que ↑ et ↓ tombent juste. En liste de
// résultats, une ligne vaut une colonne.
function columns() {
  if (state.mode === 'hits') return 1;
  const dock = $('dock');
  const tile = dock.querySelector('.fav');
  if (!tile) return 1;
  return Math.max(1, Math.round(dock.clientWidth / tile.getBoundingClientRect().width));
}

// Événements du processus principal
window.aura.onSessions((list) => { state.sessions = list; renderSessions(); });

window.aura.onCall((call) => { state.call = call; renderCall(); });

window.aura.onUpdate((etat) => {
  updateState = { ...(updateState || {}), ...etat };
  // Le panneau se redessine seul s'il est ouvert : sinon l'utilisateur verrait
  // une barre de progression figée.
  if (!$('panelSettings').hidden) renderSettings();
});

// Le miroir vit désormais dans le centre de contrôle.
async function openMirrorFromMenu() {
  try {
    await window.aura.openMirror();
    toast('Écran du téléphone');
  } catch (err) {
    toast(messageErreur(err), true);
  }
}

$('callSee').onclick = () => window.aura.openMirror().catch(() => {});
$('callTake').onclick = async () => {
  toast((await window.aura.answerCall()) ? 'Décroché' : "Le téléphone n'a pas répondu", false);
};
$('callDrop').onclick = async () => {
  toast((await window.aura.hangUpCall()) ? 'Raccroché' : "Le téléphone n'a pas répondu", false);
};

// Un lancement raté est le seul événement qu'Aura ne peut pas se permettre de
// taire : sans lui, l'utilisateur voit « s'ouvre… » puis plus rien du tout.
window.aura.onFailure((info) => {
  const detail = info.hint || info.reason || info.error || 'échec inconnu';
  toast(`${info.name} ne s'est pas ouverte — ${detail} (cliquez pour le détail)`, true, () => {
    window.aura.openDiagnostic();
  });
});

// Le guet vit dans le processus principal : la page se contente de suivre.
window.aura.onNotifications((list) => {
  state.notifications = list;
  notifSignature = list.map((n) => n.key).join('\n');
  renderNotifications();
});
window.aura.onWallpaper((frame) => paintWallpaper(frame));
window.aura.onTransfer((info) => onTransfer(info));
window.aura.onShown(() => {
  $('query').select();
  $('query').focus();
  pollNotifications();
  reconnect();
});

// Les notifications, l'état de l'appareil et les radios se rafraîchissent tant
// que la fenêtre est visible ; masquée, elle ne réveille pas le téléphone pour
// rien.
setInterval(() => { if (!document.hidden) { pollNotifications(); pollQuick(); } }, 20000);
setInterval(() => { if (!document.hidden) reconnect(); }, 60000);

boot().catch((err) => toast(messageErreur(err), true));
