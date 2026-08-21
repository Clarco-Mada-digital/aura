# Aura

Un widget de bureau pour ouvrir vos applications Android sur votre ordinateur.

Une barre de recherche, vos applications épinglées en dessous, une cloche pour
les notifications du téléphone. Rien d'autre à l'écran : les autres
applications se trouvent par la recherche, et chacune s'ouvre dans **sa propre
fenêtre**, sur **son propre écran virtuel Android**, à une densité pensée pour
un grand écran.

---

## Ce que fait Aura

| | |
| :--- | :--- |
| **Recherche** | Le nom, un fragment de paquet, ou des initiales (`gmp` → Google Maps) |
| **Favoris** | Une seule ligne, qui défile à l'horizontale ; ★ épingle, le glisser-déposer réordonne |
| **Fenêtres** | Une application = un processus scrcpy = un écran virtuel Android |
| **Notifications** | Balayez pour écarter, cliquez pour ouvrir l'application qui l'a posée |
| **Raccourci global** | `Ctrl+Alt+Espace` fait apparaître ou disparaître le widget |
| **Icône de barre** | Le widget vit dans la zone de notification, jamais dans la barre des tâches |

Le widget apparaît **en haut, au centre** de l'écran où se trouve le pointeur,
s'ajuste à la hauteur de son contenu, et **reste en place** : ouvrir une
application ne le referme pas. L'épingle (allumée par défaut) le maintient
visible même quand il perd le focus ; éteignez-la pour un comportement de
projecteur, qui s'efface au premier clic ailleurs.

### Clavier

| Touche | Effet |
| :--- | :--- |
| `Ctrl+Alt+Espace` | Afficher / masquer (réglable, capture au clavier) |
| Frappe directe | Aller à la recherche |
| `↑ ↓ ← →`, `Tab` | Naviguer |
| `Entrée` | Ouvrir |
| `Ctrl+D` | Épingler ou retirer des favoris |
| `Ctrl+N` / `Ctrl+,` | Notifications / réglages |
| `Ctrl+R` | Reconstruire l'inventaire des applications |
| `Échap` | Vider la recherche, puis masquer |

---

## Pourquoi c'est bâti ainsi

Aura **ne décode pas la vidéo et ne compose pas de fenêtres**. Il délègue tout à
[scrcpy](https://github.com/Genymobile/scrcpy) : capture et encodage sur le
téléphone, décodage matériel sur le PC (VAAPI, D3D11VA, VideoToolbox), affichage
GPU. Trois conséquences pratiques :

**Aucune fenêtre n'est reparentée.** Chaque application est un processus isolé
dont la fenêtre appartient au gestionnaire de fenêtres du système : accroche aux
bords, Alt+Tab et multi-écran fonctionnent, et une application qui tombe
n'emporte ni les autres, ni le widget.

**Les commandes système ciblent explicitement le profil 0.** Sur un téléphone
qui héberge plusieurs profils — Samsung Secure Folder, Dual Messenger, Island —
`pm` et `am` visent le profil au premier plan et échouent avec une
`SecurityException`. Voir [`src/device.js`](src/device.js).

**Un scrcpy trop ancien est refusé, pas toléré.** Les écrans virtuels
(`--new-display`) n'existent qu'à partir de scrcpy 3.0, alors que beaucoup de
distributions livrent encore la 1.25. Aura s'arrête avec un message explicite
plutôt que d'échouer plus loin sans raison lisible.

### Les icônes

Android ne sait pas livrer l'icône d'une application par ADB : la seule source
est l'APK, qui pèse parfois cent mégaoctets. Aura ne lit donc que les octets
utiles — le sommaire du zip, puis la seule entrée de l'icône — et conserve le
résultat sur disque.

Le nom du fichier ne suffit pas : les outils de construction renomment les
ressources, et l'icône de Brave s'appelle `res/xF.png`. Ce qui survit au
renommage, ce sont les **noms de ressources** (`ic_launcher`), lus dans
`resources.arsc` par [`src/arsc.js`](src/arsc.js). Une application dont l'icône
n'est qu'un XML (icône adaptative sans rendu matriciel) garde sa pastille
colorée, ce qui reste préférable à un carré vide.

### Écarter une notification

Android n'expose aucune commande « dismiss » par ADB : `cmd notification` ne
connaît que `snooze`. Un balayage met donc la notification en sommeil pour
vingt-quatre heures, ce qui la retire du volet aussi sûrement qu'un geste sur le
téléphone, sans toucher à l'application qui l'a posée.

De même, les intentions attachées à une notification ne sont pas déclenchables
depuis l'ordinateur : cliquer ouvre l'application concernée dans sa propre
fenêtre, ce qui est le geste attendu dans la quasi-totalité des cas.

### Le raccourci global

`AltGr` n'est pas utilisable : sous X11 c'est `ISO_Level3_Shift`, une touche de
composition. Electron ne refuse pas la combinaison — il abat le processus sur un
`Check failed: false`. Aura valide donc l'accélérateur avant de l'enregistrer,
et le réglage se **capture au clavier** plutôt qu'il ne se tape, ce qui rend une
combinaison impossible littéralement insaisissable.

Si le raccourci demandé est refusé — combinaison invalide, ou déjà prise par une
autre application — Aura descend une liste de repli (`Ctrl+Alt+Espace`,
`Super+A`, `Ctrl+Alt+A`…) et annonce celui qu'il a retenu, plutôt que de vous
laisser sans raccourci.

Le défaut évite les combinaisons courantes : `Ctrl+Espace` appartient aux
méthodes de saisie, `Alt+Espace` au menu de fenêtre.

### La taille des fenêtres d'application

Une fenêtre d'application fait exactement la taille de son écran virtuel :
`--new-display=1280x800` ouvre un pavé de 1280 px de large. C'est beaucoup pour
une application de téléphone posée à côté de son travail. Il y a deux façons de
la rétrécir, et elles ne donnent pas du tout le même résultat.

**Réduire l'image.** L'écran virtuel garde sa définition et sa densité, et
scrcpy met la vidéo à l'échelle : la mise en page est celle du téléphone, en
plus petit et plus net. C'est le comportement par défaut.

**Réduire l'écran virtuel** (case *Suivre la fenêtre*). Android relaie une
surface plus petite et refait sa mise en page. Le piège est là : à densité
constante, une fenêtre de 360 px à 320 ppp ne fait plus que **180 dp** de
large — Android y voit un téléphone minuscule et dessine tout en énorme. Aura
réduit donc la densité dans la même proportion que la définition : même nombre
de dp, même mise en page, simplement dessinée sur moins de pixels.

Le premier mode demande `--window-width`/`--window-height`, que scrcpy refuse
dès que `--flex-display` est actif — puisque c'est alors la fenêtre qui
commande la définition. D'où les deux chemins.

*Réglages → Taille à l'ouverture* règle la part de l'écran de travail occupée,
de 35 % à 85 %. Sur un écran de 1920 × 1032, à 55 %, un écran virtuel
900 × 1600 s'ouvre dans une fenêtre de 319 × 567 : dix conversations visibles
là où il en tenait quatre.

### Une interface qui change vraiment de taille

Redimensionner une fenêtre ne suffit pas à redimensionner ce qu'elle contient.
Une mise en page classique déplace ses blocs et laisse les textes et les icônes
à leur taille : la fenêtre rétrécit, le contenu déborde ou se serre, et rien
n'a l'air juste.

Ici, toutes les longueurs de l'interface sont exprimées en `rem`, et la valeur
du `rem` suit la largeur de la fenêtre :

```css
html { font-size: clamp(10.5px, 2.45vw, 16px); }
```

Une seule ligne, et l'ensemble — textes, icônes, vignettes de favoris,
espacements, rayons — grandit et rétrécit d'un bloc, en gardant ses
proportions. Les bornes évitent les deux excès : illisible en dessous, énorme
au-delà. Seuls les traits d'un pixel restent en pixels : à l'échelle, ils
deviendraient flous.

### Le fond flouté

Aucun compositeur Linux n'expose de façon portable ce qui se trouve derrière une
fenêtre transparente. Aura photographie donc l'écran juste avant d'afficher le
widget, et le rendu s'en sert comme fond, décalé à la position de la fenêtre et
flouté. Le réglage se désactive si vous préférez le verre sombre seul.

---

## Installation

### Prérequis

- Node.js 18 ou plus récent
- Un téléphone sous **Android 11 ou plus**, **débogage USB** activé
- `adb` dans le `PATH`

### Mise en place

```bash
npm install
npm start
```

Si aucun scrcpy 3.0+ n'est trouvé, **Aura propose de l'installer lui-même** :
l'accueil affiche un bouton, l'archive officielle est téléchargée, son
empreinte SHA-256 est vérifiée avant d'être ouverte, et le tout atterrit dans
le dossier de données de l'application. Les archives de scrcpy embarquent
aussi `adb` : les deux dépendances sont réglées d'un coup, sur les trois
systèmes.

| Système | Archive installée | Dossier |
| :--- | :--- | :--- |
| Linux x86_64 | `scrcpy-linux-x86_64` | `~/.local/share/aura/engine` |
| Windows 64 bits | `scrcpy-win64` | `%LOCALAPPDATA%\aura\engine` |
| macOS Intel / Apple Silicon | `scrcpy-macos-*` | `~/Library/Application Support/aura/engine` |

Rien n'est téléchargé si un scrcpy 3.0+ est déjà là — celui du `PATH`, ou
celui d'OpenDex qu'Aura sait réutiliser, cache d'icônes compris. Sur Linux ARM,
où le projet scrcpy ne publie pas de binaire, l'interface le dit au lieu
d'afficher un bouton qui ne mènerait nulle part.

Pour une installation en ligne de commande, `./scripts/install-engine.sh` fait
la même chose côté Linux.

Pour un raccourci dans le menu des applications :

```bash
./scripts/installer-raccourci.sh
```

### Paquets

```bash
npm run dist:linux   # AppImage + .deb
npm run dist:win     # installeur NSIS + exécutable portable
npm run dist:mac     # dmg + zip, Intel et Apple Silicon
npm run pack         # dossier non empaqueté, pour essayer sans installer
```

| Fichier | Usage |
| :--- | :--- |
| `Aura-x.y.z-x86_64.AppImage` | Aucun droit requis : `chmod +x`, puis double-clic |
| `aura_x.y.z_amd64.deb` | `sudo apt install ./dist/aura_x.y.z_amd64.deb` |
| `Aura-x.y.z-x64-setup.exe` | Installeur Windows, par utilisateur, dossier au choix |
| `Aura-x.y.z-arm64.dmg` | macOS — non signé, voir plus bas |

Chaque système ne se construit que sur lui-même : `npm run dist:win` depuis
Linux ne produira pas d'installeur utilisable. C'est le rôle du flux de
publication, qui construit les trois en parallèle.

Les paquets macOS et Windows ne sont **pas signés** — il n'y a pas de
certificat Apple ni Authenticode derrière ce projet. Au premier lancement,
macOS demande un clic droit → « Ouvrir », et Windows affiche l'écran bleu
SmartScreen (« Informations complémentaires » → « Exécuter quand même »).

Le paquet embarque Electron mais **pas** `adb` ni `scrcpy` : ils restent
fournis par le système ou installés par Aura elle-même, pour que la mise à
jour de scrcpy ne dépende pas de celle d'Aura.

### Publier une version

```bash
./scripts/release.sh 0.2.0     # ou: patch, minor, major
```

Le script vérifie que le dossier de travail est propre, pose le numéro de
version, l'étiquette, et pousse. C'est l'étiquette qui déclenche le flux
`.github/workflows/release.yml` : trois machines — Ubuntu, Windows, macOS —
construisent leurs paquets et les déposent sur la **même publication**, laissée
en **brouillon**. On relit les notes, puis on publie.

Rien ne se construit à chaque poussée : une version ne sert qu'au moment où on
la distribue. Le flux se déclenche aussi à la main depuis l'onglet *Actions*
(« Run workflow »), avec un numéro de version optionnel — pratique pour
essayer la chaîne sans poser d'étiquette.

Si un système échoue, les deux autres aboutissent quand même, et les paquets
construits restent récupérables comme artefacts de l'exécution.

### Variables d'environnement

| Variable | Effet |
| :--- | :--- |
| `AURA_SCRCPY` | Chemin d'un binaire scrcpy 3.0+ |
| `AURA_ADB` | Chemin d'`adb` |
| `AURA_SHOT` | Écrit une capture de l'interface dans ce fichier, au démarrage |
| `AURA_DEBUG` | Recopie le journal sur la sortie d'erreur, en plus du fichier |

---

## Premier lancement

L'inventaire des applications passe par `scrcpy --list-apps`, qui donne le
**libellé localisé** de chaque application en plus de son paquet — « Samsung
Browser », là où `pm list packages` ne donne que
`com.sec.android.app.sbrowser`. L'opération demande une vingtaine de secondes
pour cent cinquante applications ; le résultat est mis en cache, et se
reconstruit par `Ctrl+R` ou depuis les réglages.

Les icônes s'extraient ensuite une par une, en arrière-plan. Un seul câble USB
relie l'ordinateur au téléphone : les demandes sont sérialisées, sans quoi elles
se gêneraient les unes les autres.

---

## Appels et écran du téléphone

### Le miroir

Tout ce qui est **système** refuse un écran virtuel : l'écran d'appel entrant,
le volet de notifications, les réglages Android. Ces surfaces s'affichent sur
l'écran par défaut, et le seul moyen de les voir depuis l'ordinateur est de le
recopier. Le bouton en forme de téléphone, dans la barre du widget, ouvre ce
miroir — une seule fenêtre à la fois, deux copies du même écran ne feraient que
doubler le coût d'encodage.

### Passer un appel

Tapez un numéro dans la barre de recherche : à partir de quatre chiffres, une
ligne *Appeler …* apparaît au-dessus des applications. Elle ouvre le composeur
du téléphone dans une fenêtre Aura, le numéro déjà saisi — il ne reste qu'à
appuyer sur le bouton vert.

C'est volontairement `ACTION_DIAL` et non `ACTION_CALL` : un numéro mal tapé
partirait trop vite. Le composeur n'est pas codé en dur non plus, il est
demandé à Android (`cmd package resolve-activity`), qui répond
`com.samsung.android.dialer` ici et autre chose ailleurs.

### Recevoir un appel

`dumpsys telecom` donne l'état réel des appels — plus fiable que la
notification, qui dépend de l'application. Le filtre s'applique **sur
l'appareil** : la sortie complète pèse 170 ko, la ligne utile une trentaine
d'octets, et l'historique est écarté par un ancrage en début de ligne.

Quand le téléphone sonne, un bandeau apparaît en haut du widget avec *Voir*,
*Répondre* et *Refuser* ; le miroir s'ouvre tout seul, et le widget passe au
premier plan. Décrocher passe par `KEYCODE_HEADSETHOOK` — la touche des kits
mains-libres, celle qu'Android accepte encore d'une source externe — et
raccrocher par `KEYCODE_ENDCALL`.

Android masque le numéro dans cette sortie ; c'est la notification de l'appel
qui donne le nom de l'appelant, et le bandeau va le chercher là.

### Ce qui n'est pas possible

**Parler dans le micro de l'ordinateur.** scrcpy sait *capturer* l'audio du
téléphone, y compris celui d'un appel (`--audio-source=voice-call`), mais il
n'injecte aucun son *vers* l'appareil — aucune option ne le permet. On peut
donc voir l'appel, décrocher depuis le PC et l'entendre dans les haut-parleurs
de l'ordinateur, mais pour répondre il faut le micro du téléphone ou un casque
Bluetooth apparié avec lui. Aucun contournement ADB n'existe.

---

## Mise à jour

Aura interroge les publications GitHub vingt secondes après le démarrage —
pas avant : les premières secondes appartiennent à l'inventaire des
applications et à l'extraction des icônes, qui se partagent déjà le câble USB.

Deux garde-fous. Le téléchargement ne part pas sans accord si l'automatisme est
désactivé, parce qu'une centaine de mégaoctets ne se prend pas sans prévenir
sur une connexion facturée au volume. Et rien ne s'installe en pleine session :
le paquet est posé, et remplace l'application au redémarrage — tout de suite si
on clique sur l'alerte, au prochain lancement sinon.

*Réglages → Mise à jour* montre l'état et permet de vérifier à la main. En
développement, la section le dit et se désactive : `electron-updater` n'a pas
de paquet auquel se comparer.

Sous Linux, seule l'**AppImage** se met à jour ainsi. Un `.deb` s'installe et
se met à jour par le gestionnaire de paquets du système ; c'est le prix d'un
paquet intégré à la distribution.

---

## Quand une application ne s'ouvre pas

C'est le défaut le plus déroutant qu'une application de ce genre puisse avoir :
on clique, le widget dit « s'ouvre… », et il ne se passe rien. Le processus
scrcpy est mort en une seconde, avec un message précis — mais dans un terminal
que personne ne regarde, puisque Aura est lancée depuis un menu.

Aura traite donc l'échec comme un événement à part entière :

- un lancement qui **s'arrête sans avoir affiché de fenêtre** est un échec, pas
  une fermeture ; la différence est visible à l'écran ;
- un lancement qui **n'a rien affiché au bout de 45 secondes** est abandonné
  plutôt que laissé en processus fantôme ;
- le message brut de scrcpy est remonté, et une table de causes connues le
  traduit en français : codec refusé, écran virtuel impossible, appareil non
  autorisé, aucun serveur graphique joignable, bibliothèques incompatibles ;
- tout part dans `~/.config/aura/aura.log`, avec la ligne de commande exacte.

**Réglages → Diagnostic → Ouvrir** ouvre une fenêtre à part — cadre normal,
taille libre, texte sélectionnable — avec ce qui diffère d'une machine à
l'autre : version de scrcpy et son chemin, version d'`adb`, appareil et niveau
d'API, type de session graphique, outils de fenêtrage présents, le dernier
échec avec sa sortie, et les trois cents dernières lignes du journal. Un
rapport de trente lignes n'est pas lisible dans un widget de 520 px qui ajuste
sa hauteur à son contenu : c'est le genre de page qu'on lit en grand et qu'on
copie. *Copier le rapport* met le tout dans le presse-papiers.

Deux causes reviennent souvent :

- **Android antérieur à 11.** Les écrans virtuels n'existent pas avant ; le
  diagnostic le signale explicitement.
- **scrcpy trop ancien.** Beaucoup de distributions livrent encore une version
  1.x ou 2.x, qui ne connaît pas `--new-display`. Installez le moteur depuis
  Aura : la version officielle 4.1 sera utilisée sans toucher à celle du
  système.

Aura nettoie aussi l'environnement transmis à scrcpy : lancée en AppImage, elle
hérite d'un `LD_LIBRARY_PATH` et d'un `PATH` qui pointent vers ses propres
dossiers, et un processus fils qui en hérite peut charger les bibliothèques
d'Electron au lieu de celles du système — puis mourir sans rien afficher.

---

## Structure

```
src/main.js      fenêtre, raccourci global, icône de barre, canaux IPC
src/preload.js   pont entre l'interface et le processus principal
src/device.js    adb et scrcpy : appareil, applications, sessions, notifications
src/icons.js     extraction des icônes (lecture partielle de l'APK)
src/arsc.js      lecture de resources.arsc, pour les icônes renommées
src/store.js     réglages, favoris, historique (JSON)
src/install.js   téléchargement et vérification de scrcpy
src/windows.js   lever et réduire les fenêtres d'application (X11)
src/log.js       journal de bord, pour les échecs qu'on ne voit pas passer
src/update.js    vérification et installation des nouvelles versions
ui/              interface : index.html, style.css, app.js
```

Les réglages vivent dans `~/.config/aura/config.json`, les icônes dans
`~/.config/aura/icons/`.

---

## Performance

Mesures faites sur l'appareil de référence (Galaxy A71, USB 2.0) :

| | |
| :--- | :--- |
| Démarrage | 157 ms jusqu'à Electron prêt, 474 ms jusqu'au premier rendu |
| Mémoire au repos | ~307 Mo (PSS, 8 processus) — le plancher d'Electron |
| Sondage des notifications | 226 octets / 0,05 s toutes les 20 s |
| Détail des notifications | 1,1 Mo / 0,33 s, seulement quand la liste a changé |
| État de l'appareil | ~0,17 s, toutes les 60 s, sans redessin si rien n'a bougé |
| Inventaire des applications | ~20 s, une fois, puis cache disque |
| Icône, première extraction | 0,8 à 7 s selon l'APK, puis instantané |

Deux choix expliquent l'essentiel :

**Le sondage ne rapatrie pas le dump.** `dumpsys notification` pèse plus d'un
mégaoctet ; `cmd notification list` tient en deux cents octets et donne les
mêmes clés. Le premier n'est demandé que si l'ensemble a changé, ou si le volet
est ouvert — soit environ cinq mille fois moins de trafic USB dans le cas
courant.

**Rien n'est redessiné sans raison.** La reconnexion périodique compare l'état
avant de reconstruire l'interface : sans cela, le dock clignoterait chaque
minute et perdrait la sélection en cours.

Le poste de dépense restant est Electron lui-même. Une réimplémentation sur
Tauri — la pile d'OpenDex — descendrait vers 50 Mo, au prix d'une réécriture du
processus principal ; le rendu, lui, resterait tel quel.

## Sécurité

**Tout ce qui part vers le shell de l'appareil est échappé.** Ce n'est pas
théorique : la clé d'une notification contient l'étiquette choisie par
l'application qui l'a posée — texte libre, apostrophes comprises — et elle est
passée à `cmd notification`. Sans échappement, une application installée sur le
téléphone pourrait faire exécuter ce qu'elle veut dans le shell ADB. Les noms de
paquets sont validés, les chemins d'APK échappés, et les arguments de scrcpy
passent par un tableau d'arguments, jamais par un shell.

**Le rendu est isolé.** `contextIsolation`, `nodeIntegration: false`, bac à
sable actif, et une CSP qui interdit tout ce qui n'est pas local
(`default-src 'none'`). L'interface ne connaît ni `adb` ni `scrcpy` : elle ne
dispose que des canaux déclarés dans `src/preload.js`. La navigation hors du
fichier local est refusée, les fenêtres externes ne s'ouvrent que pour `http(s)`,
et toute demande de permission web est rejetée.

**Les données restent locales.** Aucune requête réseau n'est faite par
l'application. Les notifications — qui contiennent des messages privés — ne sont
ni journalisées ni écrites sur disque ; seuls les réglages, les favoris et les
icônes le sont, dans `~/.config/aura/`.

**Les entrées binaires sont bornées.** L'APK et `resources.arsc` viennent de
l'appareil : la décompression est plafonnée (une entrée annoncée à 500 Kio ne
peut pas se déplier en gigaoctets), les tailles de table et les compteurs du
lecteur ARSC aussi.

Point restant : `install-engine.sh` télécharge scrcpy en HTTPS depuis GitHub
sans vérifier de somme de contrôle. La signature des versions officielles serait
le bon complément.

## Pistes

- **Presse-papiers partagé** entre l'ordinateur et le téléphone.
- **Glisser-déposer de fichiers** vers une fenêtre d'application (`adb push`).
- **Notifications du système hôte** : relayer celles du téléphone dans le centre
  de notifications de Linux, plutôt que de les garder dans le volet.
- **Plusieurs appareils** en parallèle, avec un sélecteur dans la barre.
- **Groupes de favoris** (travail, loisir) commutables d'une touche.
- **Ouverture d'une application sur un écran précis**, et mémorisation de la
  taille de fenêtre par application.
- **Démarrage automatique** à l'ouverture de session, et reprise des fenêtres
  qui étaient ouvertes.
- **Écoute des notifications en temps réel** par un service compagnon
  (`NotificationListenerService`), ce qui supprimerait le sondage — et
  permettrait de répondre depuis l'ordinateur.

## Limites connues

- Le son de l'appareil demande Android 11 ou plus (`--audio`).
- Une icône purement adaptative (XML) n'est pas rendue : la pastille prend le
  relais.
- Les notifications sont lues par `dumpsys` : le contenu masqué sur l'écran de
  verrouillage ne remonte pas, et une notification écartée réapparaît au bout de
  vingt-quatre heures si l'application la maintient.
- Un seul appareil à la fois. S'il y en a plusieurs, le dernier utilisé garde la
  main.
