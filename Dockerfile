# Stage 1: build
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY web/package.json ./web/
RUN pnpm install --frozen-lockfile --ignore-scripts --filter wine-search-engine...
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# Skip `pnpm run build` (artifacts:link + tsc): Alpine has no bash; link script is for local dev paths.
RUN pnpm exec tsc --project tsconfig.build.json

# Stage 2: production
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY web/package.json ./web/
RUN pnpm install --frozen-lockfile --ignore-scripts --prod --filter wine-search-engine...
COPY --from=builder /app/dist ./dist
EXPOSE 3000
USER node
CMD ["node", "--experimental-vm-modules", "dist/main.js"]
