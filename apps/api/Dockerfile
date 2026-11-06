# Stage 1: Build workspace packages and API service
FROM node:24-alpine AS builder

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/database/package.json ./packages/database/
COPY packages/document-processing/package.json ./packages/document-processing/
COPY packages/assessment-engine/package.json ./packages/assessment-engine/
COPY apps/api/package.json ./apps/api/

RUN npm ci --ignore-scripts

COPY prisma ./prisma/
COPY prisma.config.ts ./
RUN npx prisma generate

COPY packages ./packages/
COPY apps/api ./apps/api/
COPY tsconfig*.json ./

RUN npm run build --workspace @talentlens/shared && \
    npm run build --workspace @talentlens/document-processing && \
    npm run build --workspace @talentlens/database && \
    npm run build --workspace @talentlens/assessment-engine && \
    npm run build --workspace @talentlens/api

RUN npm prune --omit=dev

# Stage 2: Production runtime image
FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY --chown=node:node package.json ./
COPY --chown=node:node packages ./packages/
COPY --chown=node:node apps/api/package.json ./apps/api/
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --chown=node:node --from=builder /app/packages/database/dist ./packages/database/dist
COPY --chown=node:node --from=builder /app/packages/document-processing/dist ./packages/document-processing/dist
COPY --chown=node:node --from=builder /app/packages/assessment-engine/dist ./packages/assessment-engine/dist
COPY --chown=node:node --from=builder /app/apps/api/dist ./apps/api/dist

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/v1/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "apps/api/dist/server.js"]
