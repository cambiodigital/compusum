FROM oven/bun:latest AS base

# 1. Dependencias
FROM base AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install

# 2. Builder
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG DATABASE_URL="postgresql://postgres:postgres@localhost:5432/compusum?schema=public"
ENV DATABASE_URL=$DATABASE_URL
# Generamos el Prisma Client antes de hacer el build de Next.js
RUN bunx prisma generate
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build

# 3. Runner (Producción)
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=80
ENV HOSTNAME=0.0.0.0

# Copiamos la build standalone.
# El script build de tu package.json ya se encarga de meter 'public' y '.next/static' aquí.
COPY --from=builder /app/.next/standalone ./

# IMPORTANTE: Copiamos explicitamente Prisma engine porque el modo standalone a veces lo oculta.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma

COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 80

CMD ["./docker-entrypoint.sh"]
