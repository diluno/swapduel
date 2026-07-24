FROM node:22-bookworm-slim

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile

ENV NODE_ENV="production"

RUN pnpm build

USER node

WORKDIR /app/apps/server

CMD ["node", "--import", "tsx", "src/index.ts"]
