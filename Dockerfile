# Stage 1: build
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# Skip `npm run build` (artifacts:link + tsc): Alpine has no bash; link script is for local dev paths.
RUN npx tsc --project tsconfig.build.json

# Stage 2: production
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --only=production --ignore-scripts
COPY --from=builder /app/dist ./dist
EXPOSE 3000
USER node
CMD ["node", "--experimental-vm-modules", "dist/main.js"]
