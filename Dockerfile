FROM node:22-bookworm-slim

ENV PNPM_HOME=/home/node/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

WORKDIR /app
RUN chown node:node /app

USER node
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/home/node/.local/share/pnpm/store,uid=1000,gid=1000 \
  pnpm fetch --frozen-lockfile
COPY --chown=node:node . .
RUN --mount=type=cache,target=/home/node/.local/share/pnpm/store,uid=1000,gid=1000 \
  pnpm install --offline --frozen-lockfile
ARG NEXT_PUBLIC_API_URL=https://paymap-api-staging.onrender.com
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN pnpm build

ENV NODE_ENV=production
EXPOSE 10000
CMD ["pnpm", "--filter", "@paymap/api", "start"]
