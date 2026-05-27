FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY web/package.json ./web/
RUN pnpm install --frozen-lockfile --ignore-scripts --filter wine-search-engine...
COPY tsconfig.json tsconfig.base.json tsconfig.build.json ./
COPY src ./src
EXPOSE 3000
USER node
CMD ["pnpm", "exec", "tsx", "src/main.ts"]
