# Compusum

Plataforma web de ecommerce y gestion comercial desarrollada con Next.js, TypeScript y Prisma.

## Autoria

Este proyecto es desarrollado y mantenido por Cambio Digital, agencia especializada en desarrollo de software, automatizacion de procesos e integraciones.

Sitio oficial: [www.cambiodigital.net](https://www.cambiodigital.net)

## Stack Tecnologico

- Next.js 16 (App Router)
- TypeScript 5
- Tailwind CSS 4
- Prisma ORM
- NextAuth.js
- Zustand
- React Hook Form + Zod
- shadcn/ui + Radix UI

## Configuracion

Se requiere Bun y una instancia PostgreSQL accesible desde la aplicacion.

Defina estas variables antes de ejecutar comandos que usen la base de datos:

```bash
# Obligatoria para Prisma, migraciones, validacion y seed.
DATABASE_URL="postgresql://USUARIO:CONTRASENA@HOST:5432/BASE_DE_DATOS?schema=public"
```

Variables opcionales segun las integraciones habilitadas:

- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` y `TWILIO_VERIFY_SERVICE_SID`: requeridas para el login por SMS con Twilio Verify en produccion.
- `N8N_API_KEY`: requerida para autorizar el webhook `POST /api/webhooks/n8n`.
- `ENABLE_MOCK_PHONE_OTP=true`: habilita OTP de prueba solo en desarrollo. `MOCK_PHONE_OTP` permite cambiar el codigo de prueba.

No habilite `ENABLE_MOCK_PHONE_OTP` en produccion.

## Desarrollo

```bash
# Instalar dependencias
bun install

# Generar el cliente, aplicar migraciones ya versionadas,
# validar la alineacion del esquema y cargar datos iniciales.
bun run db:init

# Ejecutar en desarrollo
bun run dev
```

Aplicacion disponible en: http://localhost:3000

Para crear y aplicar una nueva migracion durante el desarrollo use `bun run db:migrate`. No use ese comando en produccion.

## Estructura del Proyecto

```text
src/
|- app/                 # Paginas y rutas con App Router
|- components/          # Componentes reutilizables
|  |- admin/            # UI y flujos de administracion
|  |- store/            # UI y flujos de tienda
|  `- ui/               # Componentes base (shadcn/ui)
|- hooks/               # Hooks personalizados
|- lib/                 # Utilidades y servicios
`- stores/              # Estado global (Zustand)
```

## Funcionalidades Principales

- Catalogo de productos por categorias, marcas y temporadas.
- Flujo de carrito compartible y checkout.
- Modulo administrativo para productos, pedidos, categorias y configuracion.
- Endpoints API para tienda, admin, autenticacion y webhooks.
- Integracion de base de datos con Prisma y migraciones versionadas.

## Base de Datos

El esquema de datos se encuentra en `prisma/schema.prisma`.

La secuencia operativa actual es la siguiente:

```bash
# Generar cliente Prisma
bunx prisma generate

# Aplicar exclusivamente las migraciones versionadas
bunx prisma migrate deploy

# Verificar que no exista drift estructural entre la base y el esquema
bun run db:validate

# Cargar o actualizar datos iniciales mediante el script del proyecto
bun run seed
```

`bun run db:init` ejecuta esa misma secuencia en orden y falla si `DATABASE_URL` no esta definida. El seed no se ejecuta mediante `prisma db seed`: el proyecto no declara configuracion Prisma para ese comando.

## Produccion

Compile la aplicacion antes de iniciarla:

```bash
bun install --frozen-lockfile
bunx prisma generate
bun run build
bun start
```

`bun start` ejecuta `bun run db:init` antes de levantar el servidor standalone; por tanto aplica `migrate deploy`, valida la alineacion y ejecuta `bun run seed` en cada arranque. La imagen Docker usa el mismo flujo desde `docker-entrypoint.sh`.

Al construir con el `Dockerfile` actual, proporcione `DATABASE_URL` tanto como argumento de build como variable de entorno del contenedor, ya que el archivo la consume en ambas etapas.

## Documentacion

- Estructura del repositorio: `docs/estructura-repo.md`
- Rutas de envio: `docs/shipping/api-reference.md`
- Ejemplos de checkout para rutas: `docs/shipping/checkout-examples.md`
- Upsert de carritos y ordenes: `docs/orders/cart-order-upsert.md`
- Registros historicos de trabajo: `docs/history/worklog.md`

## Sistema de estilos y tema

Los tokens visuales globales (colores, radios, sombras, transiciones, tipografias) viven en `src/app/globals.css`.

Regla de consistencia:

- No agregar colores hardcodeados (`#hex`, `rgb`, `rgba`) en codigo nuevo.
- Usar clases semanticas globales (`font-heading`, `font-body`) para tipografia.
- Para nuevos estilos reutilizables, primero crear/actualizar tokens en `:root` y luego consumirlos en componentes.

Validacion automatica para cambios nuevos de UI:

```bash
bun run styles:guard
```

Este comando revisa solo lineas nuevas/modificadas y evita que entren estilos hardcodeados fuera del sistema de tokens.

## Soporte y Contacto

Para evolucion del proyecto, nuevas funcionalidades o automatizaciones a medida:

- Web: [www.cambiodigital.net](https://www.cambiodigital.net)

---

Proyecto desarrollado por Cambio Digital.
