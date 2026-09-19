"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle, Loader2 } from "lucide-react";
import { PHONE_OTP_MAX_LENGTH, PHONE_OTP_MIN_LENGTH } from "@/lib/phone-otp";

const OTP_RESEND_COOLDOWN_SECONDS = 60;

type LoginMethod = "password" | "code";

interface IngresarFormProps {
  /** Ruta solicitada antes del login; el backend la autoriza según el rol. */
  next?: string;
}

/**
 * LOGIN UNIFICADO (/ingresar): un único acceso para clientes, asesores
 * (AGENT), editores y administradores. Identificador primero (email o
 * teléfono) y dos métodos claros: Contraseña o Código de acceso (email ->
 * correo; teléfono -> SMS). El destino post-login lo decide el backend
 * (`redirectTo`); aquí nunca se calcula según el rol.
 */
export function IngresarForm({ next }: IngresarFormProps) {
  const router = useRouter();
  const [method, setMethod] = useState<LoginMethod>("password");

  // Identificador compartido por ambos métodos.
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);

  // Código de acceso
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const cooldownTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devHint, setDevHint] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (cooldownTimer.current) clearInterval(cooldownTimer.current);
    };
  }, []);

  const startCooldown = (seconds: number) => {
    setCooldown(seconds);
    if (cooldownTimer.current) clearInterval(cooldownTimer.current);
    cooldownTimer.current = setInterval(() => {
      setCooldown((current) => {
        if (current <= 1) {
          if (cooldownTimer.current) clearInterval(cooldownTimer.current);
          return 0;
        }
        return current - 1;
      });
    }, 1000);
  };

  const isEmailIdentifier = identifier.includes("@");

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setDevHint(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password, rememberMe, next }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Credenciales inválidas");
      }
      // El backend autoriza el destino (next saneado o home del rol).
      router.push(data.data.redirectTo);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error desconocido");
    } finally {
      setLoading(false);
    }
  };

  const handleSendCode = async () => {
    setError(null);
    setDevHint(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/otp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        if (res.status === 429 && data.retryAfterSeconds) {
          startCooldown(Math.min(data.retryAfterSeconds, OTP_RESEND_COOLDOWN_SECONDS));
        }
        throw new Error(data.error || "No fue posible enviar el código");
      }
      setCodeSent(true);
      startCooldown(OTP_RESEND_COOLDOWN_SECONDS);
      if (process.env.NODE_ENV !== "production" && data?.data?.debugCode) {
        setDevHint(`Código de desarrollo: ${data.data.debugCode}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error enviando el código");
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/otp/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, code, rememberMe, next }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Código inválido o expirado");
      }
      router.push(data.data.redirectTo);
      router.refresh();
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
            <CardTitle className="text-2xl">Iniciar sesión</CardTitle>
            <CardDescription>
              Accede con tu cuenta, sea cliente o parte del equipo Compusum
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2 mb-4">
              <Button
                type="button"
                variant={method === "password" ? "default" : "outline"}
                size="sm"
                className="flex-1"
                onClick={() => {
                  setMethod("password");
                  setError(null);
                  setDevHint(null);
                }}
              >
                Contraseña
              </Button>
              <Button
                type="button"
                variant={method === "code" ? "default" : "outline"}
                size="sm"
                className="flex-1"
                onClick={() => {
                  setMethod("code");
                  setError(null);
                  setDevHint(null);
                }}
              >
                Código de acceso
              </Button>
            </div>

            {error && (
              <Alert variant={devHint ? "default" : "destructive"} className="mb-4">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {devHint && (
              <Alert className="mb-4">
                <AlertDescription>{devHint}</AlertDescription>
              </Alert>
            )}

            {method === "password" ? (
              <form onSubmit={handlePasswordLogin} className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="identifier-password">
                    Correo o teléfono
                  </label>
                  <Input
                    id="identifier-password"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    required
                    autoComplete="username"
                    placeholder="3001234567 o correo@empresa.com"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="password">
                    Contraseña
                  </label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="current-password"
                    placeholder="Tu contraseña"
                  />
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  Mantener sesión iniciada por 30 días
                </label>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Iniciar sesión
                </Button>
              </form>
            ) : !codeSent ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="identifier-code">
                    Correo o teléfono
                  </label>
                  <Input
                    id="identifier-code"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    required
                    placeholder="3001234567 o correo@empresa.com"
                  />
                  <p className="text-xs text-slate-500">
                    {isEmailIdentifier
                      ? "Te enviaremos un código a tu correo."
                      : "Te enviaremos un código por SMS a tu teléfono."}
                  </p>
                </div>
                <Button
                  className="w-full"
                  disabled={!identifier.trim() || cooldown > 0 || loading}
                  onClick={handleSendCode}
                >
                  {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  {cooldown > 0 ? `Espera ${cooldown}s para reenviar` : "Enviar código"}
                </Button>
              </div>
            ) : (
              <form onSubmit={handleVerifyCode} className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="otp-code">
                    Código de acceso
                  </label>
                  <p className="text-xs text-slate-500">
                    Código enviado a{" "}
                    <strong>{isEmailIdentifier ? identifier : `+57 ${identifier}`}</strong>. Expira
                    en 10 minutos.
                  </p>
                  {/* TRANSICIÓN 4→6: Twilio Verify aún puede generar códigos de
                      4 dígitos; el botón habilita desde 4. El estándar nuevo es
                      6 (email OTP y SMS tras actualizar CodeLength). */}
                  <Input
                    id="otp-code"
                    type="text"
                    inputMode="numeric"
                    placeholder="123456"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, PHONE_OTP_MAX_LENGTH))}
                    maxLength={PHONE_OTP_MAX_LENGTH}
                    className="text-center text-2xl tracking-widest"
                  />
                </div>
                <Button type="submit" className="w-full" disabled={code.length < PHONE_OTP_MIN_LENGTH || loading}>
                  {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Verificar e ingresar
                </Button>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" className="w-full" onClick={() => setCodeSent(false)}>
                    Volver
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    onClick={handleSendCode}
                    disabled={cooldown > 0 || loading}
                  >
                    {cooldown > 0 ? `Reenviar en ${cooldown}s` : "Reenviar código"}
                  </Button>
                </div>
              </form>
            )}

            <div className="text-sm text-center text-slate-600 space-y-1 mt-4">
              <p>
                <Link href="/recuperar" className="text-slate-500 hover:underline">
                  ¿Olvidaste tu contraseña?
                </Link>
              </p>
              <p>
                ¿No tienes cuenta?{" "}
                <Link href="/registrarse" className="text-blue-600 hover:underline font-medium">
                  Regístrate
                </Link>
              </p>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
