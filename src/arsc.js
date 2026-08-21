'use strict';
// Lecture de `resources.arsc`, la table de ressources d'un APK.
//
// Retrouver l'icône par le nom de son fichier marche pour les applications
// système et échoue pour la plupart des autres : les outils de construction
// renomment les ressources. Dans l'APK de Brave, l'icône s'appelle « res/xF.png »
// — aucun nom ne trahit sa fonction.
//
// Ce qui survit au renommage, ce sont les noms de ressources : `ic_launcher`
// reste `ic_launcher` dans la table. On lit donc la table pour traduire les
// noms en chemins. Rien d'autre n'est interprété : ni langues, ni densités, ni
// orientations. Le choix entre densités se fait ensuite à la taille du fichier,
// que le sommaire du zip donne gratuitement.
//
// Toutes les valeurs sont en petit-boutiste.

const STRING_POOL = 0x0001;
const TABLE = 0x0002;
const PACKAGE = 0x0200;
const TYPE = 0x0201;

const UTF8 = 1 << 8;             // drapeau d'encodage du réservoir
const ENTREE_COMPLEXE = 0x0001;  // entrée composée : aucun chemin à en tirer
const VALEUR_CHAINE = 0x03;      // référence à une chaîne du réservoir global

const u16 = (b, p) => (p + 2 <= b.length ? b.readUInt16LE(p) : null);
const u32 = (b, p) => (p + 4 <= b.length ? b.readUInt32LE(p) : null);

// Les deux encodages préfixent la chaîne par sa longueur, sur un ou deux
// éléments selon que le bit de poids fort est armé — c'est ainsi que le format
// exprime les longueurs qui ne tiennent pas sur sept bits.
function readString(block, start, utf8) {
  try {
    if (utf8) {
      let p = start;
      const skip = (block[p] & 0x80) !== 0 ? 2 : 1; // longueur en caractères
      p += skip;
      const first = block[p];
      let bytes;
      if ((first & 0x80) !== 0) {
        bytes = ((first & 0x7f) << 8) | block[p + 1];
        p += 2;
      } else {
        bytes = first;
        p += 1;
      }
      return block.slice(p, p + bytes).toString('utf8');
    }
    const first = block.readUInt16LE(start);
    let length = first;
    let p = start + 2;
    if ((first & 0x8000) !== 0) {
      length = ((first & 0x7fff) << 16) | block.readUInt16LE(start + 2);
      p = start + 4;
    }
    return block.slice(p, p + length * 2).toString('utf16le');
  } catch (_) {
    // Une chaîne illisible devient vide plutôt que d'interrompre la lecture :
    // un seul encodage inattendu ne doit pas priver toute l'application d'icône.
    return '';
  }
}

function readPool(block) {
  if (!block || block.length < 28 || u16(block, 0) !== STRING_POOL) return null;
  const headerSize = u16(block, 2);
  const count = u32(block, 8);
  const flags = u32(block, 16);
  const stringsStart = u32(block, 20);
  if (count === null || count > 4000000 || headerSize + count * 4 > block.length) return null;
  const utf8 = (flags & UTF8) !== 0;

  const strings = new Array(count);
  for (let i = 0; i < count; i++) {
    const offset = u32(block, headerSize + i * 4) || 0;
    strings[i] = readString(block, stringsStart + offset, utf8);
  }
  return strings;
}

function readType(block, types, keys, global, wanted, out) {
  const id = block[8];
  const typeName = types[id - 1];
  if (!typeName || !wanted.includes(typeName)) return;

  const headerSize = u16(block, 2);
  const count = u32(block, 12);
  const entriesStart = u32(block, 16);
  if (count === null || count > 200000) return;

  for (let i = 0; i < count; i++) {
    const offset = u32(block, headerSize + i * 4);
    // 0xFFFFFFFF marque une entrée absente pour cette configuration.
    if (offset === null || offset === 0xffffffff) continue;
    const start = entriesStart + offset;

    const flags = u16(block, start + 2);
    if (flags === null || (flags & ENTREE_COMPLEXE) !== 0) continue;
    const entryHeader = u16(block, start);
    const key = u32(block, start + 4);
    if (entryHeader === null || key === null) continue;

    // La valeur suit immédiatement l'en-tête de l'entrée.
    const value = start + entryHeader;
    if (block[value + 3] !== VALEUR_CHAINE) continue;
    const index = u32(block, value + 4);
    const name = keys[key];
    const filePath = global[index];
    if (name === undefined || filePath === undefined) continue;

    out.push({ type: typeName, name, path: filePath });
  }
}

function readPackage(block, global, wanted, out) {
  const headerSize = u16(block, 2);
  const typesOffset = u32(block, 268);
  const keysOffset = u32(block, 276);
  if (headerSize === null || typesOffset === null || keysOffset === null) return;

  const types = readPool(block.slice(typesOffset));
  const keys = readPool(block.slice(keysOffset));
  if (!types || !keys || !types.length || !keys.length) return;

  let p = headerSize;
  while (p + 8 <= block.length) {
    const kind = u16(block, p);
    const size = u32(block, p + 4);
    if (kind === null || size === null || size === 0 || p + size > block.length) break;
    if (kind === TYPE) readType(block.slice(p, p + size), types, keys, global, wanted, out);
    p += size;
  }
}

// Parcourt la table et retourne les ressources de type fichier des types
// demandés — seulement ceux-là, pour ne pas bâtir une liste de dizaines de
// milliers d'entrées dont une seule servira.
function fileResources(arsc, wanted = ['mipmap', 'drawable']) {
  const out = [];
  if (!arsc || arsc.length < 12 || u16(arsc, 0) !== TABLE) return out;
  const headerSize = u16(arsc, 2);

  // Le réservoir global suit l'en-tête : c'est lui qui contient les chemins.
  const global = readPool(arsc.slice(headerSize));
  if (!global) return out;

  let p = headerSize;
  while (p + 8 <= arsc.length) {
    const kind = u16(arsc, p);
    const size = u32(arsc, p + 4);
    if (kind === null || size === null || size === 0 || p + size > arsc.length) break;
    if (kind === PACKAGE) readPackage(arsc.slice(p, p + size), global, wanted, out);
    p += size;
  }
  return out;
}

// Note d'une ressource d'après son nom. Plus haut vaut mieux. Ces noms
// résistent au renommage, contrairement aux chemins de fichiers.
function scoreResource(res) {
  const name = res.name.toLowerCase();
  // Ces ressources accompagnent l'icône sans la représenter : le fond d'une
  // icône adaptative est un aplat, la silhouette monochrome un pictogramme de
  // barre d'état, l'ombre un simple dégradé.
  for (const banned of ['notification', 'monochrome', 'background', 'shadow', 'badge', '_bg', '_stat_']) {
    if (name.includes(banned)) return 0;
  }
  if (name === 'ic_launcher' || name === 'ic_launcher_round') return 5;
  if (name === 'app_icon' || name === 'ic_app_icon') return 4;
  if (name.includes('launcher') && name.includes('foreground')) return 3;
  if (name.includes('launcher')) return 2;
  if (res.type === 'mipmap' && name.includes('icon')) return 1;
  return 0;
}

module.exports = { fileResources, scoreResource, readPool };
