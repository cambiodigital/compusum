"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";

/**
 * Recuperación de contraseña en dos pasos (todos los roles):
 *  1) Solicitar OTP al canal del identificador: email -> correo (Resend);
 *     teléfono -> SMS (Twilio). Respuesta genérica anti-enumeración.
 *  2) Verificar OTP + nueva contraseña. Al terminar se cierran todas las
 *     sesiones.
 */
export default function RecuperarPage() {
  const [step, setStep] = useState<"request" | "reset">("request");
  const [phoneOrEmail, setPhoneOrEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const handleRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneOrEmail }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "No fue posible enviar el código");
      }
      setInfo(data.message);
      setStep("reset");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error desconocido");
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneOrEmail, otpCode: otp, newPassword }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "No fue posible restablecer la contraseña");
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error desconocido");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-secondary">
      <main className="flex-1 flex items-center justify-center py-12 px-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-2xl">Recuperar contraseña</CardTitle>
            <CardDescription>
              Te enviaremos un código a tu correo o al teléfono registrado en tu cuenta.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {error && (
              <Alert variant="destructive" className="mb-4">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {done ? (
              <div className="space-y-4 text-center">
                <CheckCircle2 className="h-10 w-10 text-green-600 mx-auto" />
                <p className="text-sm text-slate-700">
                  Tu contraseña fue restablecida. Por seguridad cerramos todas las sesiones
                  abiertas de tu cuenta.
                </p>
                <Button asChild className="w-full">
                  <Link href="/ingresar">Iniciar sesión</Link>
                </Button>
              </div>
            ) : step === "request" ? (
              <form onSubmit={handleRequest} className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Teléfono o correo de tu cuenta</label>
                  <Input
                    value={phoneOrEmail}
                    onChange={(e) => setPhoneOrEmail(e.target.value)}
                    required
                    placeholder="3001234567 o correo@empresa.com"
                  />
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Enviar código
                </Button>
                <p className="text-xs text-slate-500 text-center">
                  Si tu cuenta no tiene correo ni teléfono registrado, contacta a tu asesor
                  comercial.
                </p>
              </form>
            ) : (
              <form onSubmit={handleReset} className="space-y-4">
                {info && (
                  <Alert className="mb-2">
                    <AlertDescription>{info}</AlertDescription>
                  </Alert>
                )}
                <div className="space-y-2">
                  <label className="text-sm font-medium">Código recibido</label>
                  {/* TRANSICIÓN 4→6: acepta 4–8 dígitos mientras Twilio Verify
                      aún genere códigos de 4; el email OTP ya usa 6. */}
                  <Input
                    value={otp}
                    onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 8))}
                    required
                    inputMode="numeric"
                    placeholder="123456"
                    className="text-center text-2xl tracking-widest"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Nueva contraseña</label>
                  <Input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    required
                    minLength={8}
                    maxLength={72}
                    placeholder="Mínimo 8 caracteres"
                  />
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Restablecer contraseña
                </Button>
              </form>
            )}

            <div className="text-sm text-center text-slate-600 mt-4">
              <Link href="/ingresar" className="text-slate-500 hover:underline">
                Volver a iniciar sesión
              </Link>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
