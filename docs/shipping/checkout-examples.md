# 📦 Sistema de Rutas por Día de Semana - Ejemplos de Checkout

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
│ Corte de pedidos: [25/03/2026 10:00 AM]                   │
│                                                              │
│ Transportadora: [Servientrega]                             │
│                                                              │
│ 📍 Días de salida (select all that apply)                  │
│ ☐ Dom  ☑ Lun  ☑ Mar  ☑ Mié  ☐ Jue  ☐ Vie  ☐ Sáb       │
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
      // estimate.nextDepartureDate = 2026-04-02T00:00:00Z
      // estimate.daysUntilDeparture = 0
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
- API de estimación: `GET /api/shipping/estimate?cityId=<id>`
