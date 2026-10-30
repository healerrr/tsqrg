FROM node:24.12.0-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@9.15.5
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY config ./config
COPY contracts ./contracts
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @aquarium/web build

FROM build AS game
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 UPLOAD_DIR=/data/uploads
RUN mkdir -p /data/uploads && chown -R node:node /data /app
USER node
EXPOSE 3000
CMD ["sh", "-c", "pnpm db:migrate && pnpm db:seed && exec node --import tsx apps/server/src/index.ts"]

FROM postgres:17.6-bookworm AS operations
RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /backups && chown 1000:1000 /backups
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /app /app
COPY scripts /app/scripts
WORKDIR /app
USER 1000:1000
ENTRYPOINT ["node", "--import", "tsx"]
CMD ["scripts/backup.ts", "--out", "/backups"]

FROM nginx:1.28.0-alpine AS web
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80

