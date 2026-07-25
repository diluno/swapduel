FROM node:22-bookworm-slim

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile

ENV NODE_ENV="production"

RUN pnpm build

# Default location of the leaderboard database, and the mount point of the
# Railway volume that keeps it across deploys. Creating it here only covers the
# no-volume case: when a volume is mounted it overlays this directory root-owned
# at boot, so the entrypoint re-applies ownership every start before dropping to
# `node`. That is why the image stays root — the drop happens in the entrypoint.
RUN mkdir -p /app/data && chown node:node /app/data

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

WORKDIR /app/apps/server

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# node:sqlite is behind a flag on Node 22 (it is unflagged from 24 onwards,
# where the flag is still accepted, so this stays correct across a bump).
CMD ["node", "--experimental-sqlite", "--import", "tsx", "src/index.ts"]
