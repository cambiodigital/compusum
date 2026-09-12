"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useCustomerAuth } from "@/hooks/use-customer-auth";
import { LoginModal } from "@/components/store/login-modal";
import {
  MyOrdersList,
  useMyOrders,
} from "@/components/store/my-orders-list";
import { LogOut, LogIn, User, KeyRound } from "lucide-react";

/**
 * Mi Cuenta (Fase 3): datos de la cuenta + pedidos reutilizando el listado
 * compartido de /mis-pedidos (una sola implementación del historial).
 */
export default function MiCuentaPage() {
  const router = useRouter();
  const { customer, loading, logout } = useCustomerAuth();
  const [loginOpen, setLoginOpen] = useState(false);

  const { orders, loading: ordersLoading } = useMyOrders(!loading && !!customer);

  const handleLogout = async () => {
    await logout();
    router.refresh();
  };

  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordMsg, setPasswordMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [passwordLoading, setPasswordLoading] = useState(false);

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordMsg(null);
    setPasswordLoading(true);
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "No fue posible cambiar la contraseña");
      }
      setPasswordMsg({ type: "ok", text: data.message || "Contraseña actualizada" });
      setCurrentPassword("");
      setNewPassword("");
    } catch (err) {
      setPasswordMsg({
        type: "err",
        text: err instanceof Error ? err.message : "Error desconocido",
      });
    } finally {
      setPasswordLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 py-10 px-4">
        <div className="max-w-4xl mx-auto">
          <div className="text-center text-slate-500">Cargando...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 py-10 px-4">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-bold text-slate-900">Mi Cuenta</h1>
          <Link href="/" className="text-sm text-slate-600 hover:text-slate-900">
            ← Volver al inicio
          </Link>
        </div>

        {/* Not logged in state */}
        {!customer ? (
          <Card className="bg-white border-slate-200">
            <CardHeader className="text-center py-12">
              <LogIn className="h-12 w-12 mx-auto mb-4 text-slate-400" />
              <CardTitle className="text-2xl mb-2">No estás logueado</CardTitle>
              <p className="text-slate-600 mb-6">
                Inicia sesión con tu teléfono para ver todos tus pedidos en cualquier dispositivo
              </p>
              <Button
                onClick={() => setLoginOpen(true)}
                className="bg-blue-600 hover:bg-blue-700 text-white mx-auto"
              >
                Iniciar sesión
              </Button>
            </CardHeader>
          </Card>
        ) : (
          <>
            {/* User Info Card */}
            <Card className="bg-white border-slate-200">
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center">
                      <User className="h-6 w-6 text-blue-600" />
                    </div>
                    <div>
                      <h2 className="text-xl font-semibold text-slate-900">{customer.name}</h2>
                      <p className="text-sm text-slate-600">{customer.phone && `+57 ${customer.phone}`}</p>
                      {customer.email && (
                        <p className="text-sm text-slate-600">{customer.email}</p>
                      )}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    className="text-red-600 border-red-300 hover:bg-red-50"
                    onClick={handleLogout}
                  >
                    <LogOut className="h-4 w-4 mr-2" />
                    Cerrar sesión
                  </Button>
                </div>
              </CardHeader>
            </Card>

            {/* Change Password */}
            <Card className="bg-white border-slate-200">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <KeyRound className="h-5 w-5 text-slate-500" />
                    <CardTitle className="text-lg">Contraseña</CardTitle>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowPasswordForm((v) => !v)}
                  >
                    {showPasswordForm ? "Cancelar" : "Cambiar contraseña"}
                  </Button>
                </div>
              </CardHeader>
              {showPasswordForm && (
                <CardContent>
                  {passwordMsg && (
                    <p
                      className={`text-sm mb-3 ${
                        passwordMsg.type === "ok" ? "text-green-700" : "text-red-600"
                      }`}
                    >
                      {passwordMsg.text}
                    </p>
                  )}
                  <form onSubmit={handleChangePassword} className="space-y-3 max-w-sm">
                    <Input
                      type="password"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      required
                      placeholder="Contraseña actual"
                    />
                    <Input
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      required
                      minLength={8}
                      maxLength={72}
                      placeholder="Nueva contraseña (mínimo 8 caracteres)"
                    />
                    <Button type="submit" className="bg-blue-600 hover:bg-blue-700" disabled={passwordLoading}>
                      {passwordLoading ? "Guardando..." : "Actualizar contraseña"}
                    </Button>
                    <p className="text-xs text-slate-500">
                      Al cambiarla se cierran las sesiones abiertas en otros dispositivos.
                    </p>
                  </form>
                </CardContent>
              )}
            </Card>

            {/* Pedidos: listado compartido con /mis-pedidos */}
            <div>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-2xl font-bold text-slate-900">Mis Pedidos</h2>
                <Link
                  href="/mis-pedidos"
                  className="text-sm text-blue-600 hover:underline"
                >
                  Ver todos →
                </Link>
              </div>

              <MyOrdersList orders={orders} loading={ordersLoading} />
            </div>
          </>
        )}
      </div>

      {/* Login Modal */}
      <LoginModal open={loginOpen} onOpenChange={setLoginOpen} />
    </div>
  );
}
