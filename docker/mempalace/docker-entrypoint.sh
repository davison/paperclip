#!/bin/sh
set -e

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

# Adjust the mempalace user's UID/GID if they differ from the runtime request
if [ "$(id -u mempalace)" -ne "$PUID" ]; then
    echo "Updating mempalace UID to $PUID"
    usermod -o -u "$PUID" mempalace
fi

if [ "$(id -g mempalace)" -ne "$PGID" ]; then
    echo "Updating mempalace GID to $PGID"
    groupmod -o -g "$PGID" mempalace
    usermod -g "$PGID" mempalace
fi

# Always fix volume ownership — rootless Podman may set incorrect owner
# even when UID/GID remap is not needed
chown -R mempalace:mempalace /data/mempalace

exec gosu mempalace "$@"
