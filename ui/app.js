'use strict';
// Interface du lanceur. Elle ne connaît ni adb ni scrcpy : tout passe par le
// pont `window.aura`.

const $ = (id) => document.getElementById(id);

const state = {
  settings: {},
  apps: [],
  device: null,
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
  state.results = numero
    ? [{ package: DIAL, name: `Appeler ${numero}`, dial: numero, system: false }, ...hits]
    : hits;
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

  if (state.device) {
    dot.className = 'dot on';
    name.textContent = state.device.model;
    const bits = [];
    if (state.device.battery !== null) bits.push(`${state.device.battery}%${state.device.charging ? ' ⚡' : ''}`);
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

    if (app.dial) {
      const glyphe = document.createElement('div');
      glyphe.className = 'app-icon sm dial';
      glyphe.innerHTML =
        '<svg viewBox="0 0 24 24"><path d="M6.6 3.5l2.6.5 1 3.4-2 1.4a12 12 0 0 0 5 5l1.4-2 3.4 1 .5 2.6a2 2 0 0 1-2 2.3A15.5 15.5 0 0 1 4.3 5.5a2 2 0 0 1 2.3-2Z"/></svg>';
      const texts = document.createElement('div');
      texts.className = 'texts';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = app.name;
      const sub = document.createElement('div');
      sub.className = 'pkg';
      sub.textContent = 'Ouvre le composeur, le numéro déjà saisi';
      texts.append(name, sub);
      row.append(glyphe, texts);
      row.addEventListener('click', () => launch(app.package, null, app.dial));
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
      note.textContent = String(err.message || err);
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

document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) closeMenu(); });
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

async function launch(pkg, once = null, numero = null) {
  if (pkg === DIAL || numero) {
    toast('Ouverture du composeur…');
    try {
      const fait = await window.aura.dial(numero);
      if (!fait || !fait.ok) toast("Le composeur n'a pas répondu", true);
    } catch (err) {
      toast(String(err.message || err), true);
    }
    return;
  }

  const app = state.apps.find((a) => a.package === pkg);
  try {
    await window.aura.launch(pkg, once);
    toast(`${app ? app.name : pkg} s'ouvre…`);
  } catch (err) {
    toast(String(err.message || err), true);
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
    toast(String(err.message || err), true);
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
    const frame =
      parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) +
      parseFloat(style.rowGap || style.gap || 0) * 3 +
      document.querySelector('.bar').offsetHeight +
      document.querySelector('.search').offsetHeight +
      document.querySelector('.foot').offsetHeight;

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
  const notifs = $('panelNotifs');
  const settings = $('panelSettings');
  notifs.hidden = which !== 'notifs';
  settings.hidden = which !== 'settings';
  $('btnNotifs').classList.toggle('active', which === 'notifs');
  $('btnSettings').classList.toggle('active', which === 'settings');
  if (which === 'notifs') pollNotifications();
  if (which === 'settings') renderSettings();
  fit();
}

const panelOpen = () => !$('panelNotifs').hidden || !$('panelSettings').hidden;

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
  $('btnPin').classList.toggle('active', !!state.settings.pinned);

  const install = await window.aura.engineTarget().catch(() => null);
  if (install) {
    state.installTarget = install.target;
    state.installVersion = install.version;
    state.installSize = install.megabytes;
  }

  compute();
  renderAll();
  pollNotifications();
  window.aura.callState().then((call) => { state.call = call; renderCall(); }).catch(() => {});

  // L'inventaire n'existe pas encore au tout premier lancement : on le
  // construit sans rien demander, l'attente est expliquée par le message.
  if (state.device && !state.apps.length) refreshApps();
}

// Barre supérieure
$('btnClose').onclick = () => window.aura.hide();
$('btnNotifs').onclick = () => openPanel(panelOpen() && !$('panelNotifs').hidden ? null : 'notifs');
$('btnSettings').onclick = () => openPanel(panelOpen() && !$('panelSettings').hidden ? null : 'settings');
$('btnCloseNotifs').onclick = () => openPanel(null);
$('btnCloseSettings').onclick = () => openPanel(null);
$('btnShade').onclick = () => { window.aura.openShade(); toast('Volet ouvert sur le téléphone'); };
$('btnClearAll').onclick = () => dismissAll();
$('device').onclick = () => reconnect();

$('btnPin').onclick = async () => {
  state.settings = await window.aura.saveSettings({ pinned: !state.settings.pinned });
  $('btnPin').classList.toggle('active', !!state.settings.pinned);
  toast(state.settings.pinned ? 'Fenêtre épinglée' : 'Fenêtre libérée');
};

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
    if (app) launch(app.package);
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

$('btnMirror').onclick = async () => {
  try {
    await window.aura.openMirror();
    toast('Écran du téléphone');
  } catch (err) {
    toast(String(err.message || err), true);
  }
};

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
window.aura.onShown(() => {
  $('query').select();
  $('query').focus();
  pollNotifications();
  reconnect();
});

// Les notifications et l'état de l'appareil se rafraîchissent tant que la
// fenêtre est visible ; masquée, elle ne réveille pas le téléphone pour rien.
setInterval(() => { if (!document.hidden) pollNotifications(); }, 20000);
setInterval(() => { if (!document.hidden) reconnect(); }, 60000);

boot().catch((err) => toast(String(err.message || err), true));
