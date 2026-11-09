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

# Preserve Prisma CLI and query engines for production migration container before pruning dev dependencies
RUN cp -r node_modules/prisma /tmp/prisma-cli 2>/dev/null || true && \
    cp -r node_modules/@prisma /tmp/prisma-engines 2>/dev/null || true && \
    npm prune --omit=dev && \
    mkdir -p node_modules/@prisma && \
    cp -rn /tmp/prisma-cli node_modules/prisma 2>/dev/null || true && \
    cp -rn /tmp/prisma-engines/* node_modules/@prisma/ 2>/dev/null || true

# Stage 2: Production runtime image
FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV API_PORT=3000

COPY --chown=node:node package.json ./
COPY --chown=node:node prisma ./prisma/
COPY --chown=node:node prisma.config.ts ./
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

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/v1/health/ready').then(async r => { if (!r.ok) process.exit(1); const j = await r.json(); process.exit(j.status === 'ready' && j.database === 'connected' ? 0 : 1); }).catch(() => process.exit(1))"

CMD ["node", "apps/api/dist/server.js"]
