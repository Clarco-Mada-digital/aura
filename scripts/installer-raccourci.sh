#!/usr/bin/env bash
# Crée le raccourci de menu (fichier .desktop) pointant vers ce dossier.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$HOME/.local/share/applications/aura.desktop"
mkdir -p "$(dirname "$TARGET")"
sed "s|PROJET|$ROOT|g" "$ROOT/scripts/aura.desktop" > "$TARGET"
chmod +x "$TARGET"
echo "Raccourci installé : $TARGET"
