"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle, Loader2, Plus } from "lucide-react";

export interface AgentOption {
  id: string;
  name: string;
  email: string | null;
}

export interface ProfileOption {
  id: string;
  name: string;
  code: string;
}

export interface CustomerFormValues {
  name: string;
  email: string;
  phone: string;
  company: string;
  taxId: string;
  address: string;
  city: string;
  notes: string;
  isActive: boolean;
  assignedAgentId: string;
  priceProfileId: string;
  password?: string;
}

const emptyValues: CustomerFormValues = {
  name: "",
  email: "",
  phone: "",
  company: "",
  taxId: "",
  address: "",
  city: "",
  notes: "",
  isActive: true,
  assignedAgentId: "",
  priceProfileId: "",
};

interface CustomerFormDialogProps {
  mode: "create" | "edit";
  agents: AgentOption[];
  profiles: ProfileOption[];
  customerId?: string;
  initialValues?: Partial<CustomerFormValues>;
  trigger?: React.ReactNode;
  /**
   * Vista AGENT comercial: oculta asesor, perfil de precio, contraseña y
   * estado de cuenta (el API ignora/forcea esos campos de todos modos).
   */
  agentView?: boolean;
}

/**
 * Formulario de cliente del maestro: datos B2B, asesor (solo AGENT activos)
 * y perfil de precio. Usado por /admin/clientes (crear) y /admin/clientes/[id] (editar).
 */
export function CustomerFormDialog({
  mode,
  agents,
  profiles,
  customerId,
  initialValues,
  trigger,
  agentView = false,
}: CustomerFormDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<CustomerFormValues>({
    ...emptyValues,
    ...initialValues,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (key: keyof CustomerFormValues) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) => {
    const value = e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value;
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const payload: Record<string, unknown> = {
        name: values.name,
        email: values.email || null,
        phone: values.phone || null,
        company: values.company || null,
        taxId: values.taxId || null,
        address: values.address || null,
        city: values.city || null,
        notes: values.notes || null,
      };
      if (!agentView) {
        payload.isActive = values.isActive;
        payload.assignedAgentId = values.assignedAgentId || null;
        payload.priceProfileId = values.priceProfileId || null;
      }
      if (values.password) payload.password = values.password;

      const res = await fetch(
        mode === "create" ? "/api/admin/customers" : `/api/admin/customers/${customerId}`,
        {
          method: mode === "create" ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Error al guardar el cliente");
      }
      setOpen(false);
      if (mode === "create") {
        setValues({ ...emptyValues });
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error desconocido");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" className="bg-blue-600 hover:bg-blue-700">
            <Plus className="h-4 w-4 mr-1" /> Nuevo cliente
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[560px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "Crear cliente" : "Editar cliente"}
          </DialogTitle>
          <DialogDescription>
            El cliente queda registrado en el maestro de cuentas (User CUSTOMER).
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Nombre / Razón social *</label>
            <Input value={values.name} onChange={update("name")} required maxLength={200} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Email</label>
              <Input type="email" value={values.email ?? ""} onChange={update("email")} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Teléfono *</label>
              <Input
                value={values.phone ?? ""}
                onChange={(e) =>
                  setValues((p) => ({ ...p, phone: e.target.value.replace(/[^\d+]/g, "").slice(0, 15) }))
                }
                required
                placeholder="3001234567"
                title="Número colombiano de 10 dígitos: canal de inicio de sesión y recuperación por OTP"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Empresa</label>
              <Input value={values.company ?? ""} onChange={update("company")} maxLength={200} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">NIT / Identificación fiscal</label>
              <Input value={values.taxId ?? ""} onChange={update("taxId")} maxLength={50} />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Dirección</label>
              <Input value={values.address ?? ""} onChange={update("address")} maxLength={300} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Ciudad</label>
              <Input value={values.city ?? ""} onChange={update("city")} maxLength={100} />
            </div>
          </div>

          {!agentView && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Asesor comercial (AGENT activo)</label>
                <select
                  value={values.assignedAgentId ?? ""}
                  onChange={update("assignedAgentId")}
                  className="flex h-9 w-full rounded-md border border-slate-200 bg-white px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
                >
                  <option value="">Sin asesor</option>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                      {agent.email ? ` (${agent.email})` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Perfil de precio</label>
                <select
                  value={values.priceProfileId ?? ""}
                  onChange={update("priceProfileId")}
                  className="flex h-9 w-full rounded-md border border-slate-200 bg-white px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
                >
                  <option value="">Precio base (sin perfil)</option>
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name} ({profile.code})
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <label className="text-sm font-medium">Notas internas</label>
            <textarea
              value={values.notes ?? ""}
              onChange={update("notes")}
              rows={2}
              maxLength={2000}
              className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
            />
          </div>

          {mode === "create" && !agentView && (
            <div className="space-y-2">
              <label className="text-sm font-medium">Contraseña inicial (opcional)</label>
              <Input
                type="password"
                value={values.password ?? ""}
                onChange={update("password")}
                minLength={8}
                maxLength={72}
                placeholder="Mínimo 8 caracteres; vacío = temporal aleatoria"
              />
            </div>
          )}

          {!agentView && (
            <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={values.isActive}
                onChange={update("isActive")}
                className="h-4 w-4 rounded border-slate-300"
              />
              Cuenta activa
            </label>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={loading}>
              Cancelar
            </Button>
            <Button type="submit" className="bg-blue-600 hover:bg-blue-700" disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {mode === "create" ? "Crear cliente" : "Guardar cambios"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Botón de creación (usado en la lista del maestro). */
export function CreateCustomerButton({ agentView = false }: { agentView?: boolean }) {
  return <CustomerFormDialogContainer mode="create" agentView={agentView} />;
}

// Wrapper que carga agentes/perfiles para el selector al montar.
// En vista AGENT no consulta form-options (capacidad global-admin).
function CustomerFormDialogContainer({
  mode,
  agentView,
}: {
  mode: "create";
  agentView?: boolean;
}) {
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (ready || agentView) return;
    fetch("/api/admin/customers/form-options")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.data) {
          setAgents(data.data.agents ?? []);
          setProfiles(data.data.profiles ?? []);
        }
      })
      .catch(() => {
        // Silencioso: selectores quedarán vacíos
      })
      .finally(() => setReady(true));
  }, [ready, agentView]);

  return (
    <CustomerFormDialog
      mode={mode}
      agents={agents}
      profiles={profiles}
      agentView={agentView}
    />
  );
}
