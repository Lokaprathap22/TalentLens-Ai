# Stage 1: Build static web assets
FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/web/package.json ./apps/web/

RUN npm ci --ignore-scripts

COPY tsconfig*.json ./
COPY packages/shared ./packages/shared/
RUN npm run build --workspace @talentlens/shared

COPY apps/web ./apps/web/

RUN npm run build --workspace @talentlens/web

# Stage 2: High-performance, unprivileged non-root static server
FROM nginxinc/nginx-unprivileged:alpine AS runner

COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://localhost:8080/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
