# Pin de versión (Fase 7): oven/bun:latest es mutable y una imagen de
# producción no puede flotar. 1.4.2 es la versión con la que se desarrolla y
# genera bun.lock; actualizar el pin junto con la toolchain, nunca "a ver".
FROM oven/bun:1.4.2 AS base

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
# Entorno determinista: el horario de negocio se calcula SIEMPRE en
# America/Bogota de forma explícita (src/lib/route-schedule.ts), nunca a partir
# de esta variable. Fijarla evita que el comportamiento dependa del host.
ENV TZ=UTC

# Copiamos la build standalone.
# El script build de tu package.json ya se encarga de meter 'public' y '.next/static' aquí.
COPY --from=builder /app/.next/standalone ./

# IMPORTANTE: Copiamos explicitamente Prisma engine porque el modo standalone a veces lo oculta.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma

COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 80

# Liveness del contenedor contra /api/health (sin DB: la DB se mide con
# /api/ready por el orquestador). start-period cubre el bootstrap inicial
# (migrate deploy + seed pueden tardar en instalaciones nuevas).
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:' + (process.env.PORT || '80') + '/api/health'); if (!r.ok) process.exit(1);"

CMD ["./docker-entrypoint.sh"]
