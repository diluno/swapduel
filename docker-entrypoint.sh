#!/bin/sh
set -e

# The Railway volume mounts over /app/data at container start, *after* the image
# is built, and a freshly created volume is owned by root. The `chown` in the
# Dockerfile therefore applies to a directory that no longer exists by the time
# the process runs: SQLite fails to create leaderboard.db with SQLITE_CANTOPEN
# and the leaderboard serves 503 forever. Ownership has to be fixed here, on
# every boot, while we are still root — then privileges are dropped for the
# actual server process.
DATA_DIR="$(dirname "${LEADERBOARD_DB_PATH:-/app/data/leaderboard.db}")"
mkdir -p "$DATA_DIR"
chown -R node:node "$DATA_DIR"

exec setpriv --reuid=node --regid=node --init-groups "$@"
