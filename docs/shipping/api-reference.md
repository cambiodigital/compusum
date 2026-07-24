# API Reference - Shipping Routes Function

## `getShippingEstimation(cityId: string)`

### Location
`src/lib/shipping-calc.ts`

### Purpose
Calculates dynamic shipping information based on a city's assigned route's day-of-week schedule.

### Parameters
- **cityId**: `string` - ID of the city (from City model)

### Returns
```typescript
Promise<{
  status: 'available' | 'cutoff_passed' | 'unavailable' | 'error'
  message: string // User-friendly message in Spanish
  routeId?: string
  routeName?: string
  nextDepartureDate?: Date
  daysUntilDeparture?: number
  cutOffTime?: Date | null
  hoursLeft?: number | null
}>
```

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
  nextDepartureDate: new Date('2026-04-06T00:00:00Z'),
  daysUntilDeparture: 3,
  cutOffTime: new Date('2026-04-06T14:00:00Z'),
  hoursLeft: 72
}
```

#### Cutoff Already Passed
```typescript
{
  status: 'cutoff_passed',
  message: 'El corte para la próxima salida (lunes) ya cerró. Contáctanos para confirmar.',
  routeId: 'route-id',
  hoursLeft: 0
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
Calculates the next available departure date based on day-of-week array.

### Parameters
- **now**: `Date` - Current date/time
- **departureDaysOfWeek**: `number[]` - Array of days (0-6, 0=Sun...6=Sat)
  - Example: `[1, 3, 5]` = Mon, Wed, Fri

### Returns
```typescript
{
  nextDepartureDate: Date
  daysUntilDeparture: number (0-6)
  dayName: string // Spanish day name
}
```

### Examples
```typescript
// Current time: Wednesday 2026-04-02 10:00 AM
// Route departs: Mon, Wed, Fri [1, 3, 5]

const result = getNextRouteDeparture(
  new Date('2026-04-02T10:00:00Z'),
  [1, 3, 5]
);

// Returns:
{
  nextDepartureDate: Date('2026-04-02T00:00:00Z'),
  daysUntilDeparture: 0,
  dayName: 'miércoles'
}
```

### Corner Cases Handled
- Same day departure: Returns 0 days
- Next week calculation: Properly wraps around (e.g., Friday → Monday is 3 days)
- Single day routes: Works with `[1]` (Monday only)
- Full-week routes: Works with `[0, 1, 2, 3, 4, 5, 6]`

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
  cutOffTime          DateTime? // When orders stop being accepted for this route
  departureDate       DateTime? // DEPRECATED - legacy field
  departureDaysOfWeek Int[]     @default([1]) // [0-6] for day of week
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

**Form Input (HTML checkboxes)**:
```html
<input type="checkbox" name="departureDays-0" /> Sunday
<input type="checkbox" name="departureDays-1" checked /> Monday
<input type="checkbox" name="departureDays-2" /> Tuesday
<input type="checkbox" name="departureDays-3" checked /> Wednesday
<!-- ... etc ... -->
```

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
