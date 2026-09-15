"use client";

import { useEffect, useState } from "react";
import { MapPin, Truck, Clock } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCartStore } from "@/stores/cart-store";

interface ShippingRoute {
  id: string;
  name: string;
  estimatedDaysMin: number;
  estimatedDaysMax: number;
  shippingCompany: string | null;
}

interface CityData {
  id: string;
  name: string;
  slug: string;
  shippingRoute: ShippingRoute | null;
}

interface DepartmentData {
  id: string;
  name: string;
  code: string;
  cities: CityData[];
}

interface ShippingEstimate {
  // Fase 5B1: `cutoff_passed` desaparece del contrato. Una ruta semanal con
  // cutoff vencido ya NO se bloquea: avanza a la siguiente salida (roll-forward).
  // `misconfigured` = la ruta tiene una programación inválida.
  status?: 'available' | 'unavailable' | 'misconfigured';
  message: string;
}

export function CitySelector() {
  const [departments, setDepartments] = useState<DepartmentData[]>([]);
  const [selectedDept, setSelectedDept] = useState<string>("");
  const [selectedCity, setSelectedCity] = useState<CityData | null>(null);
  const [estimate, setEstimate] = useState<ShippingEstimate | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [loading, setLoading] = useState(true);
  const setCustomerInfo = useCartStore((s) => s.setCustomerInfo);
  const cityId = useCartStore((s) => s.customerInfo.cityId);

  useEffect(() => {
    fetch("/api/shipping/cities")
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setDepartments(data.data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Restore selected city from store
  useEffect(() => {
    if (cityId && departments.length > 0) {
      for (const dept of departments) {
        const city = dept.cities.find((c) => c.id === cityId);
        if (city) {
          setSelectedDept(dept.id);
          setSelectedCity(city);
          break;
        }
      }
    }
  }, [cityId, departments]);

  const currentDeptCities = departments.find((d) => d.id === selectedDept)?.cities || [];

  const handleDeptChange = (deptId: string) => {
    setSelectedDept(deptId);
    setSelectedCity(null);
    setEstimate(null);
    setEstimateError(null);
    setCustomerInfo({ cityId: "" });
  };

  const handleCityChange = (cityId: string) => {
    const city = currentDeptCities.find((c) => c.id === cityId) || null;
    setSelectedCity(city);
    setEstimateError(null);
    setCustomerInfo({ cityId });
  };

  useEffect(() => {
    if (!selectedCity?.id) {
      setEstimate(null);
      setEstimateError(null);
      return;
    }

    let cancelled = false;
    setEstimating(true);
    setEstimateError(null);

    fetch('/api/shipping/estimate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cityId: selectedCity.id }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data?.message) {
          setEstimate({ status: data.status, message: data.message });
        } else {
          setEstimate(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEstimate(null);
          setEstimateError('No se pudo calcular el envío en este momento. Intenta nuevamente.');
        }
      })
      .finally(() => {
        if (!cancelled) setEstimating(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedCity?.id]);

  if (loading) {
    return (
      <div className="space-y-3 animate-pulse">
        <div className="h-10 bg-slate-100 rounded-lg" />
        <div className="h-10 bg-slate-100 rounded-lg" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 mb-1">
        <MapPin className="h-4 w-4 text-blue-600" />
        <span className="text-sm font-medium text-slate-700">Ciudad de envío</span>
      </div>

      {/* Department select */}
      <Select value={selectedDept} onValueChange={handleDeptChange}>
        <SelectTrigger>
          <SelectValue placeholder="Selecciona departamento" />
        </SelectTrigger>
        <SelectContent>
          {departments.map((dept) => (
            <SelectItem key={dept.id} value={dept.id}>
              {dept.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* City select */}
      {selectedDept && (
        <Select value={selectedCity?.id || ""} onValueChange={handleCityChange}>
          <SelectTrigger>
            <SelectValue placeholder="Selecciona ciudad" />
          </SelectTrigger>
          <SelectContent>
            {currentDeptCities.map((city) => (
              <SelectItem key={city.id} value={city.id}>
                {city.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* Shipping route info */}
      {selectedCity?.shippingRoute && (
        <div className="bg-blue-50 border border-blue-100 rounded-lg p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Truck className="h-4 w-4 text-blue-600" />
            <span className="text-sm font-medium text-blue-800">
              Ruta: {selectedCity.shippingRoute.name}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-blue-500" />
            <span className="text-sm text-blue-700">
              Tiempo estimado: {selectedCity.shippingRoute.estimatedDaysMin}-{selectedCity.shippingRoute.estimatedDaysMax} días hábiles
            </span>
          </div>
          {selectedCity.shippingRoute.shippingCompany && (
            <p className="text-xs text-blue-600 pl-6">
              Transportadora: {selectedCity.shippingRoute.shippingCompany}
            </p>
          )}
        </div>
      )}

      {estimating && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <p className="text-sm text-slate-600">Calculando próxima ruta para tu ciudad...</p>
        </div>
      )}

      {!estimating && estimate && (
        <div
          className={`rounded-lg border p-3 ${
            estimate.status === 'available'
              ? 'border-emerald-200 bg-emerald-50'
              : estimate.status === 'misconfigured'
              ? 'border-amber-200 bg-amber-50'
              : 'border-slate-200 bg-slate-50'
          }`}
        >
          <p
            className={`text-sm ${
              estimate.status === 'available'
                ? 'text-emerald-800'
                : estimate.status === 'misconfigured'
                ? 'text-amber-800'
                : 'text-slate-700'
            }`}
          >
            {estimate.message}
          </p>
        </div>
      )}

      {!estimating && estimateError && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
          <p className="text-sm text-rose-700">{estimateError}</p>
        </div>
      )}
    </div>
  );
}
