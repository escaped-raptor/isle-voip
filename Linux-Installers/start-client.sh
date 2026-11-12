#!/usr/bin/env bash
# Starts the player client. Run "bash Linux-Installers/setup.sh" first.
cd "$(dirname "$0")/../client" || exit 1
if [ ! -x node_modules/electron/dist/electron ]; then
  printf '\n  The client is not set up yet. Run "bash Linux-Installers/setup.sh" first and choose Client.\n\n'
  exit 1
fi
node build.mjs >/dev/null || exit 1
exec node_modules/electron/dist/electron . "$@"
