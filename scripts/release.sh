#!/usr/bin/env bash
# Publie une version d'Aura.
#
# Le principe : rien ne se construit tant qu'on ne le demande pas. Ce script
# pose l'étiquette, la pousse, et c'est l'étiquette qui déclenche la
# construction des trois systèmes chez GitHub. On récupère ensuite un
# brouillon de publication à relire avant de le rendre public.
#
#   ./scripts/release.sh 0.2.0     pose la version 0.2.0 et publie
#   ./scripts/release.sh patch     0.1.0 -> 0.1.1
#   ./scripts/release.sh minor     0.1.0 -> 0.2.0

set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-patch}"

mourir() { echo "✗ $*" >&2; exit 1; }

command -v git >/dev/null || mourir "git est nécessaire."
git rev-parse --git-dir >/dev/null 2>&1 || mourir "ce dossier n'est pas un dépôt git. Voir README, section « Publier »."
git remote get-url origin >/dev/null 2>&1 || mourir "aucun dépôt distant « origin ». Ajoutez-le : git remote add origin git@github.com:VOUS/aura.git"

# Une version se construit à partir de ce qui est publié, jamais à partir de
# modifications restées sur la machine.
[ -z "$(git status --porcelain)" ] || mourir "le dossier de travail contient des modifications non validées."

echo "→ vérification de la syntaxe"
npm test

echo "→ numérotation"
NOUVELLE=$(npm version "$VERSION" --message "Aura %s")
echo "  $NOUVELLE"

echo "→ envoi vers origin"
git push origin HEAD
git push origin "$NOUVELLE"

echo
echo "✓ $NOUVELLE poussée. La construction démarre pour Linux, Windows et macOS."
if command -v gh >/dev/null 2>&1; then
  echo "  Suivi     : gh run watch"
  echo "  Brouillon : gh release view $NOUVELLE --web"
else
  echo "  Suivez la construction dans l'onglet Actions du dépôt."
fi
echo "  La publication est créée en brouillon : relisez les notes, puis publiez-la."
