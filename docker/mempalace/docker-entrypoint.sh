#!/bin/sh
set -e

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

# Adjust the mempalace user's UID/GID if they differ from the runtime request
# and fix volume ownership only when a remap is needed
changed=0

if [ "$(id -u mempalace)" -ne "$PUID" ]; then
    echo "Updating mempalace UID to $PUID"
    usermod -o -u "$PUID" mempalace
    changed=1
fi

if [ "$(id -g mempalace)" -ne "$PGID" ]; then
    echo "Updating mempalace GID to $PGID"
    groupmod -o -g "$PGID" mempalace
    usermod -g "$PGID" mempalace
    changed=1
fi

if [ "$changed" = "1" ]; then
    chown -R mempalace:mempalace /data/mempalace
fi

exec gosu mempalace "$@"
