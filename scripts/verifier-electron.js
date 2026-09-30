// Vérification d'une version d'Electron, API par API.
//
//     npm run verif:electron
//
// Monter d'une version majeure d'Electron, c'est changer de Chromium, de Node
// et parfois d'API — sans qu'aucun test hors ligne ne s'en aperçoive : les
// tests de `npm test` tournent dans Node et dans jsdom, jamais dans Electron.
// Ce script, lui, exerce tout ce dont Aura dépend réellement : fenêtre
// transparente en bac à sable, pont de préchargement, icône de barre, raccourci
// global, alertes du bureau, capture d'écran. Il demande un serveur graphique.
//
// Écrit lors du passage d'Electron 33 (fin de support) à 44, où il a servi à
// répondre à la seule question qui vaille : est-ce que tout marche encore ?
const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, Notification,
        nativeImage, screen, shell, desktopCapturer } = require('electron');
const path = require('path');

const r = [];
const ok = (nom, v, note='') => r.push(`${v ? 'OK  ' : 'ÉCHEC'} ${nom}${note ? '  — ' + note : ''}`);
const essai = (nom, fn) => { try { const v = fn(); ok(nom, v !== false && v !== undefined, typeof v === 'string' ? v : ''); }
                             catch (e) { r.push(`ÉCHEC ${nom}  — ${e.message}`); } };

/// La racine du dépôt, ce script vivant dans `scripts/`.
const racine = path.join(__dirname, '..');

app.whenReady().then(async () => {
  ok('app.whenReady', true, `Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`);
  essai('app.getPath(userData)', () => !!app.getPath('userData'));
  essai('app.getVersion', () => app.getVersion());
  essai('app.isPackaged', () => app.isPackaged === false);

  // screen — placement du widget
  essai('screen.getCursorScreenPoint', () => !!screen.getCursorScreenPoint());
  essai('screen.getDisplayNearestPoint().workArea', () =>
    !!screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea);
  essai('screen.getPrimaryDisplay().workAreaSize', () => {
    const s = screen.getPrimaryDisplay().workAreaSize; return `${s.width}x${s.height}`; });

  // Icône de barre
  essai('nativeImage.createFromPath + resize', () => {
    const im = nativeImage.createFromPath(path.join(racine, 'assets', 'tray.png'));
    return !im.isEmpty() && !im.resize({ width: 22, height: 22 }).isEmpty(); });
  let tray = null;
  essai('new Tray + setToolTip + setContextMenu', () => {
    const im = nativeImage.createFromPath(path.join(racine, 'assets', 'tray.png'));
    tray = new Tray(im.resize({ width: 22, height: 22 }));
    tray.setToolTip('Aura');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Ouvrir' }, { type: 'separator' }, { label: 'Quitter' }]));
    return true; });

  // Raccourci global — avec le repli d'Aura
  essai('globalShortcut.register(Ctrl+Alt+Space)', () => globalShortcut.register('Ctrl+Alt+Space', () => {}));
  essai('globalShortcut.unregisterAll', () => { globalShortcut.unregisterAll(); return true; });

  // Alertes du bureau
  essai('Notification.isSupported', () => Notification.isSupported());
  essai('new Notification + show', () => {
    const n = new Notification({ title: 'Aura — test', body: 'vérification API', silent: true });
    n.on('click', () => {}); n.show(); setTimeout(() => n.close(), 800); return true; });

  essai('ipcMain.handle', () => { ipcMain.handle('verif:ping', async () => 'pong'); return true; });
  essai('shell.openExternal existe', () => typeof shell.openExternal === 'function');
  essai('shell.showItemInFolder existe', () => typeof shell.showItemInFolder === 'function');

  // La vraie fenêtre, avec le vrai préchargement et le vrai bac à sable
  const win = new BrowserWindow({
    width: 520, height: 240, show: false, frame: false, transparent: true,
    hasShadow: false, skipTaskbar: true, backgroundColor: '#00000000', alwaysOnTop: true,
    webPreferences: {
      preload: path.join(racine, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  essai('BrowserWindow transparente + sandbox', () => !!win);
  essai('setWindowOpenHandler', () => { win.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); return true; });
  essai('session.setPermissionRequestHandler', () => {
    win.webContents.session.setPermissionRequestHandler((_a,_b,cb) => cb(false)); return true; });

  await win.loadFile(path.join(racine, 'ui', 'index.html'));
  ok('loadFile(ui/index.html)', true);

  // Le pont est-il vraiment exposé dans un rendu en bac à sable ?
  const pont = await win.webContents.executeJavaScript(
    `({ existe: typeof window.aura === 'object',
        canaux: window.aura ? Object.keys(window.aura).length : 0,
        décrire: typeof window.aura?.décrireFichier,
        onFollow: typeof window.aura?.onFollow,
        onHidden: typeof window.aura?.onHidden })`);
  ok('contextBridge expose window.aura', pont.existe, `${pont.canaux} canaux`);
  ok('webUtils joignable depuis le préchargement', pont.décrire === 'function');
  ok('nouveaux canaux onFollow / onHidden', pont.onFollow === 'function' && pont.onHidden === 'function');

  // CSP : la page doit refuser un script distant et eval
  const csp = await win.webContents.executeJavaScript(
    `(() => { try { eval('1+1'); return 'eval AUTORISÉ'; } catch (e) { return 'eval bloqué'; } })()`);
  ok('CSP bloque eval', csp === 'eval bloqué', csp);

  essai('win.setSize / setPosition / getBounds', () => {
    win.setSize(520, 300, false); win.setPosition(100, 24, false); return !!win.getBounds(); });
  essai('win.setAlwaysOnTop', () => { win.setAlwaysOnTop(true); return true; });

  win.show();
  await new Promise((s) => setTimeout(s, 1200));
  essai('win.isVisible', () => win.isVisible());
  essai('webContents.capturePage', async () => true);
  const img = await win.webContents.capturePage();
  ok('capturePage rend une image', !img.isEmpty(), JSON.stringify(img.getSize()));

  // L'événement que j'ai ajouté
  let vuHide = false;
  win.on('hide', () => { vuHide = true; });
  win.hide();
  await new Promise((s) => setTimeout(s, 400));
  ok("événement 'hide' (source de launcher:hidden)", vuHide);

  if (tray) tray.destroy();

  const ratés = r.filter((l) => l.startsWith('ÉCHEC'));
  console.log(r.join('\n'));
  console.log(`\n${r.length - ratés.length}/${r.length} — ${ratés.length ? 'À REVOIR' : 'tout passe'}`);
  app.exit(ratés.length ? 1 : 0);
}).catch((e) => {
  console.log(r.join('\n'));
  console.error('\nINTERROMPU : ' + e.stack);
  app.exit(1);
});
