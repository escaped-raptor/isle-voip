#!/usr/bin/env bash
# ------------------------------------------------------------------
#  Species Specific VoIP - The Isle Evrima
#  Setup for Linux (and macOS).   Run:   bash Linux-Installers/setup.sh
#
#  It checks that Node.js is installed (and offers to install it),
#  then downloads the parts the client and/or the server need.
#  Nothing is installed outside this folder except Node.js itself.
#
#  You can also run:  bash Linux-Installers/setup.sh client   or   bash Linux-Installers/setup.sh server
# ------------------------------------------------------------------
set -u
cd "$(dirname "$0")/.." || exit 1
pick="${1:-}"

say()  { printf '  %s\n' "$*"; }
fail() { printf '\n'; say "$*"; printf '\n'; exit 1; }

printf '\n'
say "Species Specific VoIP - The Isle Evrima"
say "Setup"
say "---------------------------------------"
printf '\n'

[ -f client/package.json ] && [ -f server/package.json ] ||
  fail 'Run this from the project folder, next to the "client" and "server" folders.'

node_major() { node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; }

offer_node() {
  local how=""
  if command -v apt-get >/dev/null 2>&1; then
    how='curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs'
  elif command -v dnf >/dev/null 2>&1; then
    how='sudo dnf install -y nodejs'
  elif command -v pacman >/dev/null 2>&1; then
    how='sudo pacman -S --needed nodejs npm'
  elif command -v brew >/dev/null 2>&1; then
    how='brew install node'
  fi
  if [ -z "$how" ]; then
    fail "Please install Node.js 20 or newer from https://nodejs.org, then run this setup again."
  fi
  say "It can be installed with this command, which may ask for your password:"
  printf '\n      %s\n\n' "$how"
  read -r -p "  Run it now? Type y and press Enter, or n to stop: " answer
  case "$answer" in
    y|Y) bash -c "$how" || fail "Node.js could not be installed. Install it from https://nodejs.org, then run this setup again." ;;
    *)   fail "Install Node.js 20 or newer, then run this setup again." ;;
  esac
}

if ! command -v node >/dev/null 2>&1; then
  say "This needs Node.js, a free program that runs the client and server."
  say "It is not installed on this computer yet."
  printf '\n'
  offer_node
fi
major="$(node_major)"
if [ -z "$major" ] || [ "$major" -lt 20 ]; then
  say "Node.js $(node -v 2>/dev/null) is installed, but version 20 or newer is needed."
  printf '\n'
  offer_node
  major="$(node_major)"
  { [ -n "$major" ] && [ "$major" -ge 20 ]; } || fail "Node.js is still older than version 20. Install a newer one from https://nodejs.org."
fi
say "Node.js $(node -v) is installed. Good."
printf '\n'

while :; do
  case "$pick" in
    1|client) want_client=1; want_server=0; break ;;
    2|server) want_client=0; want_server=1; break ;;
    3|both)   want_client=1; want_server=1; break ;;
    4|exit)   exit 0 ;;
  esac
  say "What would you like to set up on this computer?"
  printf '\n'
  say "  1  Client   for players"
  say "  2  Server   for whoever runs the Isle Evrima server"
  say "  3  Both     to try everything on one computer"
  say "  4  Exit"
  printf '\n'
  read -r -p "  Type 1, 2, 3 or 4 and press Enter: " pick || exit 1
  printf '\n'
done

install_in() {
  ( cd "$1" && npm install --no-fund --no-audit --loglevel=error ) ||
    fail "Something went wrong while downloading in \"$1\". Check your internet connection and run this setup again. It is safe to run as many times as you like."
}

if [ "$want_client" = 1 ]; then
  say "Setting up the client. This downloads about 300 MB and can take a few minutes..."
  printf '\n'
  install_in client
  ( cd client && npm run build ) || fail "The client could not be built. The message above says why."
  printf '\n'
  say "The client is ready."
  printf '\n'
fi
if [ "$want_server" = 1 ]; then
  say "Setting up the server. This downloads about 300 MB and can take a few minutes..."
  printf '\n'
  install_in server
  install_in server-app
  printf '\n'
  say "The server is ready."
  printf '\n'
fi

say "---------------------------------------"
say "All done."
printf '\n'
[ "$want_client" = 1 ] && say "To start the client:  bash Linux-Installers/start-client.sh"
if [ "$want_server" = 1 ]; then
  say "To start the server:  bash Linux-Installers/start-server.sh            (window and tray icon)"
  say "                      bash Linux-Installers/start-server.sh --no-window  (for a server with no desktop)"
  printf '\n'
  say "The first time the server starts it asks a few setup questions."
  say 'To try it on this computer only, choose "Testing without a certificate".'
fi
printf '\n'
