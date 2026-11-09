# Stage 1: Build workspace packages and worker service
FROM node:24-alpine AS builder

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/database/package.json ./packages/database/
COPY packages/document-processing/package.json ./packages/document-processing/
COPY packages/assessment-engine/package.json ./packages/assessment-engine/
COPY apps/worker/package.json ./apps/worker/

RUN npm ci --ignore-scripts

COPY prisma ./prisma/
COPY prisma.config.ts ./
RUN npx prisma generate

COPY packages ./packages/
COPY apps/worker ./apps/worker/
COPY tsconfig*.json ./

RUN npm run build --workspace @talentlens/shared && \
    npm run build --workspace @talentlens/document-processing && \
    npm run build --workspace @talentlens/database && \
    npm run build --workspace @talentlens/assessment-engine && \
    npm run build --workspace @talentlens/worker

RUN npm prune --omit=dev

# Stage 2: Production runtime image
FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Install production OCR runtime dependencies (Tesseract OCR engine, English language model, Poppler utilities)
RUN apk add --no-cache tesseract-ocr tesseract-ocr-data-eng poppler-utils

COPY --chown=node:node package.json ./
COPY --chown=node:node packages ./packages/
COPY --chown=node:node apps/worker/package.json ./apps/worker/
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --chown=node:node --from=builder /app/packages/database/dist ./packages/database/dist
COPY --chown=node:node --from=builder /app/packages/document-processing/dist ./packages/document-processing/dist
COPY --chown=node:node --from=builder /app/packages/assessment-engine/dist ./packages/assessment-engine/dist
COPY --chown=node:node --from=builder /app/apps/worker/dist ./apps/worker/dist

USER node

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "apps/worker/dist/healthcheck.js"]

CMD ["node", "apps/worker/dist/index.js"]
