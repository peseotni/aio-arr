#!/bin/sh
# Make sure the config folder belongs to PUID:PGID (like the linuxserver.io images);
# the Node process then drops root privileges itself, so files placed in your
# music / audiobook libraries get the same owner as the rest of your media.
set -e
umask "${UMASK:-002}"
CONFIG_DIR="${CONFIG_DIR:-/config}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$CONFIG_DIR"
  chown -R "${PUID:-1000}:${PGID:-1000}" "$CONFIG_DIR" 2>/dev/null || echo "warning: could not change the owner of $CONFIG_DIR"
fi
exec "$@"
