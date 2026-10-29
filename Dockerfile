FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
COPY data ./data
COPY docs ./docs
COPY README.md LICENSE ./
COPY skills ./skills
COPY .claude-plugin ./.claude-plugin
COPY scripts/package-hosted.mjs ./scripts/package-hosted.mjs
RUN node scripts/package-hosted.mjs

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/release-assets ./release-assets
COPY --chown=node:node data ./data
RUN install -d -o node -g node -m 0700 /var/lib/infomaniak-ai
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD ["node","dist/healthcheck.js"]
CMD ["node","dist/server.js","--http"]
