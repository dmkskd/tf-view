#!/usr/bin/env bash
# Puts the base stack on the demo repo's main branch (or updates it when the stack changed), creates the
# gh-pages branch for the reports and turns GitHub Pages on. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
SHARED=../shared
URL="https://x-access-token:${GH_TOKEN}@github.com/${GH_REPO}.git"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
git() { command git -c user.name=demo -c user.email=demo@example.com "$@"; }

git clone -q "$URL" "$T/r" 2>/dev/null || { git init -q -b main "$T/r"; git -C "$T/r" remote add origin "$URL"; }
cd "$T/r"
git checkout -q main 2>/dev/null || git checkout -q -b main
rm -rf infra atlantis.yaml
cp -R "$OLDPWD/$SHARED/infra" "$OLDPWD/$SHARED/atlantis.yaml" .
git add -A
if git diff --cached --quiet; then echo "main is up to date"; else
  git commit -qm "Base stack: network and a legacy bucket"
  git push -q origin main
  echo "pushed the base stack to main"
fi

if git ls-remote --exit-code --heads origin gh-pages >/dev/null 2>&1; then echo "gh-pages exists"; else
  git checkout -q --orphan gh-pages
  git rm -rqf . 2>/dev/null || true
  mkdir reports
  printf '<!doctype html><title>tfplanview demo reports</title><p>Visual plans for the demo PR live in <a href="reports/">reports/</a>.</p>\n' > index.html
  touch reports/.nojekyll .nojekyll
  git add -A
  git commit -qm "Reports"
  git push -q origin gh-pages
  echo "created gh-pages"
fi

# Pages needs admin on the repo: use your own gh login, not the demo token
if env -u GH_TOKEN gh api -X POST "repos/${GH_REPO}/pages" -f 'source[branch]=gh-pages' -f 'source[path]=/' >/dev/null 2>&1; then
  echo "GitHub Pages enabled"
else
  echo "GitHub Pages: already on, or enable it in Settings -> Pages (Deploy from branch: gh-pages, / root)"
fi
