#!/usr/bin/env bash
# Installe le moteur vidéo d'Aura (scrcpy) dans le dossier de données de
# l'utilisateur.
#
# Les dépôts de beaucoup de distributions livrent encore scrcpy 1.25, qui ne
# connaît pas les écrans virtuels (--new-display). Ce script récupère une
# version officielle récente sans toucher au paquet système.

set -euo pipefail

VERSION="${AURA_SCRCPY_VERSION:-4.1}"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/aura"
ENGINE_DIR="$DATA_DIR/engine"

case "$(uname -s)" in
  Linux)  PLATFORM="linux" ;;
  Darwin) PLATFORM="macos" ;;
  *) echo "Système non pris en charge : $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64|amd64) ARCH="x86_64" ;;
  aarch64|arm64) ARCH="aarch64" ;;
  *) echo "Architecture non prise en charge : $(uname -m)" >&2; exit 1 ;;
esac

# Un scrcpy déjà installé ailleurs et assez récent rend le téléchargement
# inutile : Aura sait aussi utiliser celui d'OpenDex ou celui du PATH.
for candidate in "$ENGINE_DIR/scrcpy" "${XDG_DATA_HOME:-$HOME/.local/share}/opendex/engine/scrcpy" "$(command -v scrcpy || true)"; do
  [ -x "$candidate" ] || continue
  found="$("$candidate" --version 2>/dev/null | head -1 | awk '{print $2}' || true)"
  major="${found%%.*}"
  if [ -n "$major" ] && [ "$major" -ge 3 ] 2>/dev/null; then
    echo "scrcpy $found est déjà utilisable : $candidate"
    exit 0
  fi
done

ARCHIVE="scrcpy-${PLATFORM}-${ARCH}-v${VERSION}.tar.gz"
URL="https://github.com/Genymobile/scrcpy/releases/download/v${VERSION}/${ARCHIVE}"

echo "Téléchargement de scrcpy $VERSION ($PLATFORM/$ARCH)…"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl --fail --location --progress-bar --output "$TMP/$ARCHIVE" "$URL"
tar -xzf "$TMP/$ARCHIVE" -C "$TMP"

EXTRACTED="$TMP/scrcpy-${PLATFORM}-${ARCH}-v${VERSION}"
if [ ! -x "$EXTRACTED/scrcpy" ]; then
  echo "Archive inattendue : $EXTRACTED/scrcpy est introuvable" >&2
  exit 1
fi

mkdir -p "$ENGINE_DIR"
cp -r "$EXTRACTED/." "$ENGINE_DIR/"
chmod +x "$ENGINE_DIR/scrcpy" 2>/dev/null || true

echo "scrcpy $VERSION installé dans $ENGINE_DIR"
