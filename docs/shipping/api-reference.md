# API Reference - Shipping Routes Function

> **Fase 5B1 — cutoff recurrente.** La disponibilidad se calcula con un cutoff
> **recurrente semanal** en la timezone de negocio **`America/Bogota`**
> (`BUSINESS_TIMEZONE`), no con un timestamp absoluto. El campo legacy
> `cutOffTime` se conserva pero **ya no decide disponibilidad**.

## Endpoint HTTP

`POST /api/shipping/estimate` con body `{ "cityId": "<id>" }`.
Responde con el objeto de `getShippingEstimation` tal cual.
(Nota: la documentación anterior indicaba `GET` — era drift; el handler real
exporta únicamente `POST`.)

## `getShippingEstimation(cityId: string, now: Date = new Date())`

### Location
`src/lib/shipping-calc.ts`

### Purpose
Calculates dynamic shipping information based on a city's assigned route's
recurring weekly schedule, evaluated in `America/Bogota`. `now` es inyectable
para tests (los helpers puros nunca leen el reloj real).

### Parameters
- **cityId**: `string` - ID of the city (from City model)
- **now**: `Date` - instante de evaluación (por defecto, el reloj real)

### Returns
```typescript
Promise<
  | {
      status: 'available'
      message: string            // mensaje en español para el cliente
      routeId: string
      routeName: string
      nextDepartureCivilDate: string   // 'YYYY-MM-DD' en America/Bogota
      nextDepartureDayOfWeek: number   // 0=Dom … 6=Sáb
      nextDepartureDayName: string
      daysUntilDeparture: number
      hoursLeft: number | null         // null si la ruta no tiene cutoff
      effectiveCutoffAt: Date | null   // instante UTC del cutoff efectivo
      skippedDeparture: boolean        // true si se saltó una salida por corte cerrado
      skippedCivilDate: string | null
      timezone: 'America/Bogota'
    }
  | { status: 'unavailable'; message: string }
  | { status: 'misconfigured'; reason: string; routeId: string; routeName: string; message: string }
>
```

Estados:
- `unavailable` — la ciudad no existe, no tiene ruta, o la ruta está inactiva.
- `misconfigured` — la ruta tiene una programación inválida (días vacíos o
  fuera de 0–6, cutoff parcial, `cutoffDaysBefore` fuera de 0–6, hora que no es
  `HH:mm`). No se adivina ni se cae al `cutOffTime` legacy.
- `available` — hay una salida elegible.

### Examples

#### Success Case
```typescript
const result = await getShippingEstimation('city-manizales-id');

// Returns:
{
  status: 'available',
  message: 'La ruta sale el próximo lunes, en 3 días. Recibirás tu pedido entre 2 y 4 días desde la salida.',
  routeId: 'route-zona-centro-norte-id',
  routeName: 'Zona Centro Norte',
  nextDepartureCivilDate: '2026-04-06',
  nextDepartureDayOfWeek: 1,
  nextDepartureDayName: 'lunes',
  daysUntilDeparture: 3,
  hoursLeft: 72,
  effectiveCutoffAt: new Date('2026-04-03T19:00:00Z'), // viernes 14:00 en Bogotá (UTC-5)
  skippedDeparture: false,
  skippedCivilDate: null,
  timezone: 'America/Bogota'
}
```

#### Cutoff Already Passed → ROLL-FORWARD (ya NO se bloquea)
Una ruta semanal válida **nunca** queda cerrada para siempre. Si el cutoff de la
salida más próxima ya cerró, se descarta y se devuelve la SIGUIENTE salida:
```typescript
{
  status: 'available',
  message:
    'El corte de la salida más próxima (2026-09-14) ya cerró. Tu pedido viajará en la próxima salida (lunes). ' +
    'La ruta sale el próximo lunes, en 6 días. Recibirás tu pedido entre 2 y 4 días desde la salida.',
  nextDepartureCivilDate: '2026-09-21',
  daysUntilDeparture: 6,
  skippedDeparture: true,
  skippedCivilDate: '2026-09-14'
}
```
> El estado `cutoff_passed` fue **retirado** del contrato en 5B1: era justamente
> el síntoma del defecto (una ruta recurrente bloqueada indefinidamente por un
> cutoff absoluto vencido).

#### Route With Misconfigured Schedule
```typescript
{
  status: 'misconfigured',
  reason: 'partial_cutoff',
  message: 'Esta ruta no tiene una programación válida. Contáctanos para confirmar tu envío.'
}
```

#### City Has No Route
```typescript
{
  status: 'unavailable',
  message: 'Actualmente no tenemos rutas programadas para esta ciudad. Te contactaremos pronto.'
}
```

---

## `getNextRouteDeparture(now: Date, departureDaysOfWeek: number[])`

### Location
`src/lib/route-schedule.ts`

### Purpose
Calculates the next available departure **civil date** based on a day-of-week
array, evaluated in `America/Bogota` (Fase 5B1). Ya **no** depende del timezone
del proceso: el día de la semana y la fecha se derivan del calendario civil de
negocio, no de `Date.getDay()` local.

**No evalúa cutoff.** Para disponibilidad usar `resolveDepartureAvailability`.

### Parameters
- **now**: `Date` - Current date/time
- **departureDaysOfWeek**: `number[]` - Array of days (0-6, 0=Sun...6=Sat)
  - Example: `[1, 3, 5]` = Mon, Wed, Fri
  - Debe tener al menos un día, sólo enteros 0–6 (si no, lanza)

### Returns
```typescript
{
  civilDate: string            // 'YYYY-MM-DD' en America/Bogota — usar esto en UI/API
  nextDepartureDate: Date      // instante UTC de las 00:00 Bogotá de `civilDate`
  daysUntilDeparture: number   // 0-7
  dayName: string              // Spanish day name
}
```

`nextDepartureDate` representa el **inicio del día civil de salida**, NO una hora
de salida: el sistema no modela hora de salida. Es un `Date` por compatibilidad
con llamadores previos; para UI/API usar `civilDate`, que es estable porque no
arrastra timezone.

### Examples
```typescript
// Instante: miércoles 2026-04-02 10:00 en Bogotá
// Route departs: Mon, Wed, Fri [1, 3, 5]

const result = getNextRouteDeparture(
  new Date('2026-04-02T15:00:00Z'), // = 10:00 en Bogotá (UTC-5)
  [1, 3, 5]
);

// Returns:
{
  civilDate: '2026-04-02',
  nextDepartureDate: Date('2026-04-02T05:00:00Z'), // 00:00 Bogotá
  daysUntilDeparture: 0,
  dayName: 'miércoles'
}
```

### Corner Cases Handled
- Same day departure: Returns 0 days
- Next week calculation: Properly wraps around (e.g., Friday → Monday is 3 days)
- Single day routes: Works with `[1]` (Monday only)
- Full-week routes: Works with `[0, 1, 2, 3, 4, 5, 6]`
- Borde de medianoche: un instante que en UTC ya es el día siguiente pero en
  Bogotá sigue siendo el día anterior se resuelve con el día civil de Bogotá.

---

## `resolveDepartureAvailability(schedule, now)` — FUENTE ÚNICA

### Location
`src/lib/route-schedule.ts`

### Purpose
Única fuente de verdad para **ruta + próxima salida + cutoff + disponibilidad**
(Fase 5B1). Úsala en lugar de recomponer reglas de horario en otros módulos.

### Parameters
```typescript
schedule: {
  departureDaysOfWeek?: number[] | null
  cutoffDaysBefore?: number | null   // null = sin cutoff
  cutoffLocalTime?: string | null    // 'HH:mm' en America/Bogota, null = sin cutoff
}
now: Date
```

### Returns
```typescript
| {
    status: 'available'
    next: { civilDate: string; dayOfWeek: number; dayName: string; daysUntil: number; isToday: boolean }
    cutoffAtUtc: Date | null    // cutoff efectivo (UTC) o null si no hay cutoff
    hoursLeft: number | null
    skippedDeparture: boolean   // true si hubo roll-forward
    skippedCivilDate: string | null
  }
| { status: 'misconfigured'; reason: ScheduleConfigError }
```

### Semántica del cutoff recurrente
El cutoff pertenece uniformemente a **cada** salida de la ruta:

```
cutoff(salida D) = (D - cutoffDaysBefore días) a las cutoffLocalTime, en America/Bogota
```

- Una salida es elegible mientras `now < cutoff`.
- **Exactamente en el cutoff (`now === cutoff`) la salida ya está cerrada.**

### Sin cutoff (`null` + `null`)
La ruta no tiene corte. La primera salida programada es elegible, y como el
sistema **no** modela hora de salida, un día programado como salida sigue
elegible durante **todo** su día civil en Bogotá.

### Roll-forward
Si el cutoff de la salida más próxima ya cerró, se descarta y se busca la
**siguiente** salida recurrente con cutoff abierto. Una ruta semanal válida
**nunca** queda cerrada permanentemente.

### Validación
- `departureDaysOfWeek`: al menos un día, sólo enteros 0–6.
- `cutoffDaysBefore`: `null` o entero 0–6.
- `cutoffLocalTime`: `null` o `HH:mm` real (00:00–23:59).
- Válido = ambos `null`, o ambos presentes y válidos. Cualquier otro estado es
  `misconfigured` (`partial_cutoff`, `invalid_cutoff_days`,
  `invalid_cutoff_time`, `empty_days`, `invalid_days`).

---

## `buildRouteMessage(daysUntilDeparture, dayName, estimatedDaysMin, estimatedDaysMax)`

### Location
`src/lib/route-schedule.ts`

### Purpose
Generates a customer-friendly message combining departure timing and delivery estimate.

### Parameters
- **daysUntilDeparture**: `number`
- **dayName**: `string` - Spanish day name (from `getDayNameSpanish()`)
- **estimatedDaysMin**: `number` - Min delivery days from route departure
- **estimatedDaysMax**: `number` - Max delivery days from route departure

### Returns
```typescript
string // Example: "La ruta sale HOY (lunes). Recibirás tu pedido en 2 días desde la salida."
```

### Examples
```typescript
buildRouteMessage(0, 'lunes', 2, 4)
// → "✓ La ruta sale HOY (lunes). Recibirás tu pedido entre 2 y 4 días desde la salida."

buildRouteMessage(1, 'miércoles', 3, 3)
// → "La ruta sale mañana (miércoles), en 1 día. Recibirás tu pedido en 3 días desde la salida."

buildRouteMessage(3, 'viernes', 2, 4)
// → "La ruta sale el próximo viernes, en 3 días. Recibirás tu pedido entre 2 y 4 días desde la salida."
```

---

## Database Model

### ShippingRoute
```prisma
model ShippingRoute {
  id                  String    @id @default(cuid())
  name                String    // "Eje Cafetero", "Bogotá Capital", etc.
  estimatedDaysMin    Int       // Min days to deliver from departure
  estimatedDaysMax    Int       // Max days to deliver from departure
  shippingCompany     String?   // "Servientrega", optional
  notes               String?
  isActive            Boolean   @default(true)
  capacity            Int?
  cutOffTime          DateTime? // LEGACY absoluto: YA NO decide disponibilidad (5B1). Se conserva intacto.
  departureDate       DateTime? // DEPRECATED - legacy field
  departureDaysOfWeek Int[]     @default([1]) // [0-6] for day of week
  cutoffDaysBefore    Int?      // 5B1 — días civiles antes de cada salida. null = sin cutoff.
  cutoffLocalTime     String?   // 5B1 — 'HH:mm' en America/Bogota. null = sin cutoff.
  sortOrder           Int       @default(0)
  cities              City[]    // One-to-many relationship
  orders              Order[]
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt
}

model City {
  id              String         @id @default(cuid())
  name            String
  slug            String         @unique
  departmentId    String
  department      Department     @relation(fields: [departmentId], references: [id])
  shippingRoute   ShippingRoute? @relation(fields: [shippingRouteId], references: [id])
  shippingRouteId String?
  isActive        Boolean        @default(true)
  createdAt       DateTime       @default(now())
  updatedAt       DateTime       @updatedAt
}
```

---

## Admin Form Data Flow

### Creating/Updating a Route

**Form Input (HTML checkboxes + cutoff recurrente)**:
```html
<input type="checkbox" name="departureDays-0" /> Sunday
<input type="checkbox" name="departureDays-1" checked /> Monday
<input type="checkbox" name="departureDays-3" checked /> Wednesday
<!-- ... etc ... -->

<!-- Fase 5B1: cutoff recurrente. Ambos vacíos = ruta sin corte. -->
<input type="number" name="cutoffDaysBefore" min="0" max="6" />
<input type="time" name="cutoffLocalTime" step="60" />
```

`cutoffDaysBefore` y `cutoffLocalTime` se guardan **tal cual** (texto/entero).
NO se convierten con `new Date(raw)`: la hora es una hora local de negocio, no
un instante. La validación server-side reutiliza `validateRouteSchedule`, el
mismo validador del runtime.

**Server-Side Processing** (`src/app/admin/envios/page.tsx`):
```typescript
// Extract checked days
const departureDaysOfWeek: number[] = [];
for (const [key, value] of formData.entries()) {
  if (key.startsWith("departureDays-")) {
    const dayNum = parseInt(key.replace("departureDays-", ""));
    if (!isNaN(dayNum) && value === "on") {
      departureDaysOfWeek.push(dayNum); // [1, 3, 5] for Mon, Wed, Fri
    }
  }
}

// Save to database
await db.shippingRoute.update({
  where: { id },
  data: {
    departureDaysOfWeek: departureDaysOfWeek.sort((a, b) => a - b)
  }
});
```

---

## Testing Utilities

### Quick Test in Console

```typescript
import { getShippingEstimation } from '@/lib/shipping-calc';
import { getNextRouteDeparture, buildRouteMessage } from '@/lib/route-schedule';

// Test with Manizales (Monday-only route)
const manizales = await getShippingEstimation('city-manizales-id');
console.log(manizales.message);

// Test route calculation directly
const result = getNextRouteDeparture(
  new Date(),
  [1, 3, 5] // Mon, Wed, Fri
);
console.log(`Next departure: ${result.dayName} in ${result.daysUntilDeparture} days`);

// Test message generation
const msg = buildRouteMessage(2, 'miércoles', 2, 4);
console.log(msg);
```

---

## Migration Notes

### Data Migration from Old System
The migration `20260329100000_add_departure_days_of_week` automatically infers day-of-week from existing `departureDate` values:

```sql
UPDATE "ShippingRoute"
SET "departureDaysOfWeek" = ARRAY[EXTRACT(DOW FROM "departureDate")::INT]
WHERE "departureDate" IS NOT NULL;
```

If a route previously departed on March 31, 2026 (Sunday), it will be migrated to `departureDaysOfWeek = [0]`.

### Rollback Safety
- The `departureDate` column is retained for potential rollback
- Mark routes as inactive if needed to prevent use during transition
- Migration is idempotent and can be re-applied safely

### Fase 5B1 — migración `20260915120000_add_recurring_route_cutoff`

Expande `ShippingRoute` con las dos columnas del cutoff recurrente:

```sql
ALTER TABLE "ShippingRoute"
  ADD COLUMN IF NOT EXISTS "cutoffDaysBefore" INTEGER,
  ADD COLUMN IF NOT EXISTS "cutoffLocalTime" TEXT;
```

- **Expand-only**: nullable, sin default, sin `UPDATE`/backfill, sin `DROP`.
- **Sin backfill heurístico.** Del `cutOffTime` absoluto legacy NO puede
  inferirse la intención comercial: su hora local depende del timezone del
  servidor que procesó el formulario, así que no es recuperable. Las rutas
  existentes quedan en `cutoffDaysBefore = null` y `cutoffLocalTime = null`
  (= "sin cutoff recurrente"), y el timestamp legacy se conserva **intacto**.
- **Sin** índice nuevo y **sin** `UNIQUE(name)`.
- Idempotente (`ADD COLUMN IF NOT EXISTS`) porque `prisma/bootstrap.ts` ejecuta
  `migrate deploy` en cada arranque del contenedor.
- Se aplica con `prisma migrate deploy`. **Nunca** `prisma migrate dev` en
  producción/shared.
- **Efecto operativo buscado:** las rutas que hoy quedaron "cerradas para
  siempre" por un `cutOffTime` vencido vuelven a estar disponibles según su
  `departureDaysOfWeek`. El administrador carga después el cutoff recurrente
  desde `/admin/envios` si lo necesita.

