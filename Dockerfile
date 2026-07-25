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
# Railway volume that keeps it across deploys. It has to exist and be writable
# by `node` before the process drops privileges.
RUN mkdir -p /app/data && chown node:node /app/data

USER node

WORKDIR /app/apps/server

# node:sqlite is behind a flag on Node 22 (it is unflagged from 24 onwards,
# where the flag is still accepted, so this stays correct across a bump).
CMD ["node", "--experimental-sqlite", "--import", "tsx", "src/index.ts"]
