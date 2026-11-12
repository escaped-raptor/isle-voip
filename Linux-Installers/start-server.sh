#!/usr/bin/env bash
# Starts the voice server. Run "bash Linux-Installers/setup.sh" first.
#
#   bash Linux-Installers/start-server.sh              as a desktop app with a window and tray icon
#   bash Linux-Installers/start-server.sh --no-window  in this terminal, for a server with no desktop
#
# The first time, it shows (or prints the address of) a page with a few setup questions.
here="$(cd "$(dirname "$0")/.." && pwd)"
if [ ! -d "$here/server/node_modules/mediasoup" ]; then
  printf '\n  The server is not set up yet. Run "bash Linux-Installers/setup.sh" first and choose Server.\n\n'
  exit 1
fi
if [ "${1:-}" = "--no-window" ]; then
  cd "$here/server" && exec npm start
fi
if [ ! -x "$here/server-app/node_modules/electron/dist/electron" ]; then
  printf '\n  The server app is not set up yet. Run "bash Linux-Installers/setup.sh" and choose Server,\n  or start without a window:  bash Linux-Installers/start-server.sh --no-window\n\n'
  exit 1
fi
cd "$here/server-app" && exec node_modules/electron/dist/electron . "$@"
