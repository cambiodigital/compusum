# 📦 Sistema de Rutas por Día de Semana - Ejemplos de Checkout

> ⚠️ **Nota de vigencia (Fase 5B1).** Los escenarios de abajo se escribieron para
> un modelo de "corte a una hora del mismo día" que **nunca llegó a
> implementarse** (no existe hora de salida en el sistema). El modelo vigente es:
>
> - **Cutoff recurrente semanal**: `cutoffDaysBefore` (0–6 días) +
>   `cutoffLocalTime` (`HH:mm`), ambos en **`America/Bogota`**. El cutoff de cada
>   salida es `salida − cutoffDaysBefore días` a las `cutoffLocalTime`.
> - **Sin cutoff** (`null` + `null`) = la ruta no tiene corte y sale según sus
>   días; el día de salida sigue elegible durante **todo** su día civil en Bogotá.
> - **Roll-forward**: si el cutoff de la salida más próxima ya cerró, el pedido
>   viaja en la **siguiente** salida. Una ruta semanal válida nunca queda cerrada
>   permanentemente (el estado `cutoff_passed` fue retirado en 5B1).
> - Los textos "Te quedan N horas…" de los ejemplos **no** son el contrato actual.
>
> Para el contrato exacto ver `docs/shipping/api-reference.md`.

## Cómo funciona ahora

### ✅ Antes (Modelo antiguo - RETIRADO)
```
Ruta: Eje Cafetero
Próxima salida: 31/03/2026 10:00 (fecha fija)
❌ Problema: Si hoy es 01/04 y la ruta "próxima salida" dice 31/03, está confuso
```

### ✅ Ahora (Modelo nuevo - IMPLEMENTADO)
```
Ruta: Eje Cafetero
Días de salida: Lunes, Miércoles, Viernes [1, 3, 5]
✅ El sistema calcula automáticamente: "¿Cuál es el próximo lunes/miércoles/viernes?"
```

---

## 🎯 Ejemplos de Mensajes en Checkout

### Escenario 1: Cliente compra el martes para ruta de lunes
**Requisito**: Selecciona Manizales (Ruta: Zona Centro Norte, salida: Lunes)
**Hoy es**: Martes 01/04/2026, 2:00 PM

**ANTES**: "Próxima salida: 24/03/2026 ❌ PASADA"  
**AHORA**:
```
✅ La ruta sale el próximo LUNES, en 6 días.
Recibirás tu pedido entre 2 y 4 días desde la salida.
→ Entrega estimada: 8-10 días desde hoy
```

---

### Escenario 2: Cliente compra el miércoles para ruta que sale miércoles y viernes
**Requisito**: Selecciona Pereira (Ruta: Eje Cafetero, salida: Lunes, Miércoles, Viernes)  
**Hoy es**: Miércoles 02/04/2026, 10:00 AM  
**Corte de pedidos**: Hoy 12:00 PM (meodía)

**ANTES**: "Próxima salida: 31/03/2026" ❌  
**AHORA**:
```
✅ La ruta sale HOY (miércoles), en 0 días.
Te quedan 2 horas para que tu pedido entre en esta ruta.
Recibirás tu pedido entre 2 y 4 días desde la salida.
→ Si compras antes del meodía: Entrega 04-06 de abril
```

---

### Escenario 3: Cliente compra el viernes, ruta sale lunes
**Requisito**: Selecciona Bogotá (Ruta: Bogotá Capital, salida: Lunes-Viernes)  
**Hoy es**: Viernes 03/04/2026, 3:00 PM  
**Hoy es viernes. ¿Salidas viernes? SÍ**

**AHORA**:
```
✅ La ruta sale HOY (viernes), en 0 días.
Tienes 1 hora para que tu pedido entre en esta ruta.
Recibirás tu pedido entre 2 y 4 días desde la salida.
→ Entrega estimada: 05-07 de abril (lunes-miércoles)
```

---

### Escenario 4: El corte ya pasó
**Requisito**: Selecciona Cali (Ruta: Occidente, salida: Martes, Jueves)  
**Hoy es**: Martes 03/04/2026, 5:00 PM  
**Corte**: Hoy 4:00 PM (hace 1 hora)

**AHORA**:
```
⏰ El corte para la próxima salida (martes) ya cerró.
Contáctanos para confirmar si aún puedes entrar en esta ruta.

La siguiente salida disponible es: JUEVES 04/04, en 1 día.
```

---

## 📊 Tabla de Lógica

| Hoy | Ruta Días | Próxima | Días | Mensaje |
|-----|-----------|---------|------|---------|
| Lun | [1] | Lun | 7 | "sale el próx. lunes, en 7 días" |
| Lun | [2,4] | Mié | 2 | "sale el próx. miércoles, en 2 días" |
| Mié 10AM | [1,3,5] | Mié | 0 | "sale HOY (miércoles), en 0 días" |
| Mié 4PM | [1,3,5] | Vie | 2 | "sale el próx. viernes, en 2 días" |
| Jue | [1] | Lun | 4 | "sale el próx. lunes, en 4 días" |
| Sáb | [2,5] | Mar | 3 | "sale el próx. martes, en 3 días" |

---

## 🎨 Cómo se configura en Admin

### Panel de Rutas (admin/envios)

```
┌─────────────────────────────────────────────────────────────┐
│ RUTA: Eje Cafetero                                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│ Estimación (min-max días): [2] [4]                         │
│                                                              │
│ Transportadora: [Servientrega]                             │
│                                                              │
│ Corte recurrente: [3] días antes a las [14:00] — America/Bogota  │
│                                                              │
│ 📍 Días de salida (select all that apply)                  │
│ ☐ Dom  ☑ Lun  ☑ Mar  ☑ Mié  ☐ Jue  ☐ Vie  ☐ Sáb       │
│                                                              │
│ Próxima salida: lunes 06/04                                   │
│ Corte: viernes 03/04 a las 14:00 — America/Bogota             │
│                                                              │
│ [Actualizar ruta] ✓                                        │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔧 Integración en Componentes Next.js

### CheckoutFlow Component
```typescript
// Pseudocódigo
const CheckoutFlow = () => {
  const [selectedCity, setSelectedCity] = useState(null);

  useEffect(() => {
    if (selectedCity?.id) {
      const estimate = await getShippingEstimation(selectedCity.id);
      // estimate.message = "✓ La ruta sale HOY (miércoles)..."
      // estimate.nextDepartureCivilDate = '2026-04-02'  // YYYY-MM-DD en America/Bogota
      // estimate.daysUntilDeparture = 0
      // estimate.skippedDeparture = false                // true si hubo roll-forward
      setShippingInfo(estimate);
    }
  }, [selectedCity]);

  return (
    <div>
      <CitySelector onSelect={setSelectedCity} />
      {shippingInfo && (
        <ShippingAlert 
          message={shippingInfo.message}
          status={shippingInfo.status}
        />
      )}
    </div>
  );
};
```

---

## 📋 Checklist de Validación Manual

- [ ] Ir a `/admin/envios`
- [ ] Crear nueva ruta "Test Route" con días: Lunes, Miércoles
- [ ] Crear ciudad "Medellín" y asignar a "Test Route"
- [ ] Ir a `/checkout`  
- [ ] Seleccionar Antioquia > Medellín
- [ ] Verificar que el mensaje dice correctamente:
  - Si hoy es lunes: "sale HOY" o "sale el próximo miércoles"
  - Si hoy es martes: "sale el próx. miércoles, en 1 día"
  - Si hoy es jueves: "sale el próx. lunes, en 4 días"
- [ ] Editar la ruta en admin, cambiar días a solo Viernes
- [ ] Refrescar checkout y verificar que recalcula correctamente
- [ ] Verificar que los mensajes se ven bien en mobile

---

## 🚀 URLs para Pruebas

- Admin panel: `http://localhost:3000/admin/envios`
- Checkout: `http://localhost:3000/checkout` (requiere carrito)
- API de estimación: `POST /api/shipping/estimate` con body `{ "cityId": "<id>" }`
  (el handler exporta únicamente `POST`; la referencia anterior a `GET` era drift)

## 🧪 Checklist adicional de cutoff recurrente (Fase 5B1)

- [ ] Ruta con `cutoffDaysBefore` y `cutoffLocalTime` vacíos ⇒ sin corte: la
      salida del día en curso sigue elegible todo el día (hora Bogotá)
- [ ] Configurar `3` días antes a las `14:00` y verificar el preview del admin:
      debe mostrar el viernes anterior a las 14:00 — America/Bogota
- [ ] Dejar sólo los días o sólo la hora ⇒ error controlado (`partial_cutoff`)
- [ ] Con el cutoff de la salida más próxima ya vencido, el checkout sigue
      asignando `routeId` y el pedido viaja en la **siguiente** salida
