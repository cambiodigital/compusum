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

## Inicio Rapido

```bash
# Instalar dependencias
bun install

# Ejecutar en desarrollo
bun run dev

# Compilar para produccion
bun run build

# Levantar en modo produccion
bun start
```

Aplicacion disponible en: http://localhost:3000

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

Comandos utiles:

```bash
# Aplicar migraciones en entorno local
bunx prisma migrate dev

# Generar cliente Prisma
bunx prisma generate

# Ejecutar seed de datos
bunx prisma db seed
```

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
