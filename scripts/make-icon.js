'use strict';
// Fabrique l'icône de l'application (fichier PNG), sans dépendance graphique :
// les pixels sont calculés à la main, puis encodés par zlib.
//
// Le motif : une nuit profonde, un téléphone qui déborde sur une fenêtre de
// bureau — ce que fait l'application, en un signe.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// 512 px : la taille minimale exigée par les outils d'empaquetage Linux.
const SIZE = 512;
const SS = 3; // suréchantillonnage, pour des bords nets

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filtre « aucun »
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // profondeur
  ihdr[9] = 6;  // RVBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Couverture d'un rectangle arrondi, en tout ou rien (le lissage vient du
// suréchantillonnage).
function inside(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return 0;
  let dx = 0;
  let dy = 0;
  if (x < x0 + r) dx = x0 + r - x; else if (x > x1 - r) dx = x - (x1 - r);
  if (y < y0 + r) dy = y0 + r - y; else if (y > y1 - r) dy = y - (y1 - r);
  return dx * dx + dy * dy <= r * r ? 1 : 0;
}

function mix(a, b, t) {
  const k = Math.max(0, Math.min(1, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

// Le motif : un téléphone qui déborde sur une fenêtre de bureau. C'est ce que
// fait l'application, en un signe — et il tient encore à 22 px, dans la barre
// système, parce qu'il ne repose que sur deux masses et un vide entre elles.
function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const u = (v) => v * size;

  const NUIT = [10, 12, 18];
  const NUIT_CLAIRE = [26, 30, 44];
  const VIOLET = [124, 92, 255];
  const CYAN = [56, 214, 214];

  const radius = size * 0.235;

  // Fenêtre de bureau : un cadre, décalé vers la droite.
  const fen = [u(0.355), u(0.315), u(0.85), u(0.715), u(0.06)];
  const fenInt = [u(0.415), u(0.375), u(0.79), u(0.655), u(0.032)];
  // Téléphone : une masse verticale, posée par-dessus.
  const tel = [u(0.175), u(0.235), u(0.415), u(0.775), u(0.07)];
  // Le vide qui détache le téléphone du cadre.
  const creux = [u(0.145), u(0.205), u(0.447), u(0.805), u(0.09)];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cover = 0;
      let cadre = 0;
      let vide = 0;
      let phone = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          cover += inside(px, py, 0, 0, size, size, radius);
          cadre += Math.max(0, inside(px, py, ...fen) - inside(px, py, ...fenInt));
          vide += inside(px, py, ...creux);
          phone += inside(px, py, ...tel);
        }
      }
      const n = SS * SS;
      cover /= n; cadre /= n; vide /= n; phone /= n;

      // Fond : nuit profonde, éclaircie en haut à gauche, avec deux lueurs.
      const diag = (x + y) / (2 * size);
      let couleur = mix(NUIT_CLAIRE, NUIT, diag * 1.25);
      const lueurV = Math.max(0, 1 - Math.hypot(x - size * 0.16, y - size * 0.1) / (size * 0.85));
      const lueurC = Math.max(0, 1 - Math.hypot(x - size * 0.92, y - size * 0.95) / (size * 0.8));
      couleur = mix(couleur, VIOLET, lueurV * lueurV * 0.30);
      couleur = mix(couleur, CYAN, lueurC * lueurC * 0.16);

      // Le cadre, en trait clair — mais évidé là où passe le téléphone.
      const trait = Math.max(0, cadre - vide);
      couleur = mix(couleur, [226, 232, 246], trait * 0.92);

      // Le téléphone, dans le dégradé de la marque.
      const t = (y / size) * 0.75 + (x / size) * 0.25;
      couleur = mix(couleur, mix(VIOLET, CYAN, t), phone);
      // Un liseré clair sur son bord gauche, pour qu'il ne soit pas plat.
      const bordure = Math.max(0, phone - inside(x + size * 0.012, y + size * 0.008, ...tel));
      couleur = mix(couleur, [255, 255, 255], bordure * 0.35);

      const i = (y * size + x) * 4;
      rgba[i] = Math.min(255, couleur[0]);
      rgba[i + 1] = Math.min(255, couleur[1]);
      rgba[i + 2] = Math.min(255, couleur[2]);
      rgba[i + 3] = Math.round(cover * 255);
    }
  }
  return encodePng(size, size, rgba);
}

const target = path.join(__dirname, '..', 'assets');
fs.mkdirSync(target, { recursive: true });
fs.writeFileSync(path.join(target, 'icon.png'), render(SIZE));
fs.writeFileSync(path.join(target, 'tray.png'), render(64));
console.log('Icônes écrites dans', target);
