#!/usr/bin/env bash
# Builds the extension and publishes it to Open VSX (https://open-vsx.org) and/or the
# VS Code Marketplace (https://marketplace.visualstudio.com).
#
#   ./deploy.sh --build    (-b)   typecheck + production build + dbclient-<version>.vsix
#   ./deploy.sh --deploy   (-d)   publish dbclient-<version>.vsix to Open VSX (builds it if missing)
#   ./deploy.sh --marketplace (-m) publish dbclient-<version>.vsix to the VS Code Marketplace
#   ./deploy.sh -b -d -m          rebuild, then publish to both
#
# --deploy needs an Open VSX access token in OVSX_PAT (https://open-vsx.org/user-settings/tokens);
# --marketplace an Azure DevOps token with scope Marketplace > Manage in VSCE_PAT:
#   OVSX_PAT=<token> VSCE_PAT=<token> ./deploy.sh -d -m
set -euo pipefail

cd "$(dirname "$0")"

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

BUILD=false
DEPLOY=false
MARKETPLACE=false
[ $# -eq 0 ] && usage 1
for arg in "$@"; do
  case "$arg" in
    -b | --b | --build) BUILD=true ;;
    -d | --d | --deploy) DEPLOY=true ;;
    -m | --m | --marketplace) MARKETPLACE=true ;;
    -h | --help) usage 0 ;;
    *) echo "Unknown option: $arg" >&2; usage 1 ;;
  esac
done

VERSION=$(git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0")
VERSION="${VERSION#v}"
# vsce names the package after package.json's version, so the latest tag must match it.
PKG_VERSION=$(node -p "require('./package.json').version")
if [ "$VERSION" != "$PKG_VERSION" ]; then
  echo "Latest git tag (v$VERSION) and package.json version ($PKG_VERSION) differ." >&2
  echo "Run: npm version $VERSION --no-git-tag-version" >&2
  exit 1
fi
VSIX="dbclient-$VERSION.vsix"

build() {
  [ -d node_modules ] || npm ci
  echo "==> Building $VSIX"
  npm run package
  echo "==> Ready: $VSIX"
}

require() {
  if [ -z "${!1:-}" ]; then
    echo "$1 is not set ($2)." >&2
    exit 1
  fi
}

deploy() {
  [ -f "$VSIX" ] || build
  echo "==> Publishing $VSIX to Open VSX"
  npx ovsx publish "$VSIX" -p "$OVSX_PAT"
  echo "==> Published: https://open-vsx.org/extension/cgalvisleon/dbclient/$VERSION"
}

marketplace() {
  [ -f "$VSIX" ] || build
  echo "==> Publishing $VSIX to the VS Code Marketplace"
  npx vsce publish --no-dependencies --packagePath "$VSIX" -p "$VSCE_PAT"
  echo "==> Published: https://marketplace.visualstudio.com/items?itemName=cgalvisleon.dbclient"
}

# Check every token before building or publishing anything.
$DEPLOY && require OVSX_PAT "Open VSX access token"
$MARKETPLACE && require VSCE_PAT "VS Code Marketplace token"

$BUILD && build
$DEPLOY && deploy
$MARKETPLACE && marketplace
exit 0
