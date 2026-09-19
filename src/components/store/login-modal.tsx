"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertCircle, Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PHONE_OTP_MAX_LENGTH, PHONE_OTP_MIN_LENGTH } from "@/lib/phone-otp";

const OTP_PROGRESS_STORAGE_KEY = "compusum-login-otp-progress";
const OTP_PROGRESS_TTL_MS = 15 * 60 * 1000;

type OtpProgress = {
  step: "otp";
  phone: string;
  requestedAt: number;
  rememberMe: boolean;
};

interface LoginModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLoginSuccess?: () => void;
}

export function LoginModal({ open, onOpenChange, onLoginSuccess }: LoginModalProps) {
  const router = useRouter();
  const [step, setStep] = useState<"phone" | "otp">("phone");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearOtpProgress = () => {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(OTP_PROGRESS_STORAGE_KEY);
  };

  const persistOtpProgress = (nextPhone: string, nextRememberMe: boolean) => {
    if (typeof window === "undefined") return;

    const payload: OtpProgress = {
      step: "otp",
      phone: nextPhone,
      requestedAt: Date.now(),
      rememberMe: nextRememberMe,
    };

    window.localStorage.setItem(OTP_PROGRESS_STORAGE_KEY, JSON.stringify(payload));
  };

  useEffect(() => {
    if (!open || typeof window === "undefined") return;

    const raw = window.localStorage.getItem(OTP_PROGRESS_STORAGE_KEY);
    if (!raw) return;

    try {
      const saved = JSON.parse(raw) as OtpProgress;
      const isValid =
        saved?.step === "otp" &&
        typeof saved.phone === "string" &&
        saved.phone.length === 10 &&
        Date.now() - saved.requestedAt < OTP_PROGRESS_TTL_MS;

      if (!isValid) {
        clearOtpProgress();
        return;
      }

      setPhone(saved.phone);
      setStep("otp");
      setRememberMe(Boolean(saved.rememberMe));
    } catch {
      clearOtpProgress();
    }
  }, [open]);

  useEffect(() => {
    if (!open || step !== "otp" || phone.length !== 10) return;
    persistOtpProgress(phone, rememberMe);
  }, [open, phone, rememberMe, step]);

  const handlePhoneSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    // Validar formato: 10 dígitos
    const cleaned = phone.replace(/\D/g, "");
    if (cleaned.length !== 10) {
      setError("El teléfono debe tener 10 dígitos");
      setLoading(false);
      return;
    }

    try {
      const res = await fetch("/api/auth/phone/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: `+57${cleaned}` }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "No fue posible enviar el OTP");
      }

      setPhone(cleaned);
      setStep("otp");
      persistOtpProgress(cleaned, rememberMe);

      if (process.env.NODE_ENV !== "production" && data?.data?.debugCode) {
        setError(`En desarrollo, usá OTP: ${data.data.debugCode} para testear`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error enviando OTP");
    } finally {
      setLoading(false);
    }
  };

  const handleOtpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/auth/phone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: `+57${phone}`,
          otpCode: otp,
          rememberMe,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Error al verificar OTP");
      }

      // Éxito
      setPhone("");
      setOtp("");
      setRememberMe(false);
      setStep("phone");
      clearOtpProgress();
      onOpenChange(false);
      if (onLoginSuccess) {
        onLoginSuccess();
      } else {
        router.push("/mis-pedidos");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error desconocido");
    } finally {
      setLoading(false);
    }
  };

  const handleDialogOpenChange = (nextOpen: boolean) => {
    setError(null);
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Iniciar sesión con teléfono</DialogTitle>
          <DialogDescription>
            {step === "phone"
              ? "Ingresa tu número de teléfono para acceder a tus pedidos"
              : "Ingresa el código OTP enviado a tu teléfono"}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant={error.includes("desarrollo") ? "default" : "destructive"}>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {step === "phone" ? (
          <form onSubmit={handlePhoneSubmit} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Teléfono</label>
              <div className="flex">
                <span className="flex items-center px-3 bg-slate-100 text-slate-600 text-sm border border-r-0 border-slate-300 rounded-l-md">
                  +57
                </span>
                <Input
                  type="tel"
                  placeholder="3001234567"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
                  className="rounded-l-none"
                  maxLength={10}
                />
              </div>
              <p className="text-xs text-slate-500">Ingresa los 10 dígitos (sin espacios ni símbolos)</p>
            </div>

            <Button type="submit" className="w-full" disabled={phone.length !== 10 || loading}>
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Enviando...
                </>
              ) : (
                "Enviar OTP"
              )}
            </Button>
          </form>
        ) : (
          <form onSubmit={handleOtpSubmit} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Código OTP</label>
              <p className="text-xs text-slate-500 mb-2">
                Código enviado a <strong>+57 {phone.slice(0, 3)} {phone.slice(3, 6)} {phone.slice(6)}</strong>
              </p>
              <Input
                type="text"
                inputMode="numeric"
                placeholder="123456"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, PHONE_OTP_MAX_LENGTH))}
                maxLength={PHONE_OTP_MAX_LENGTH}
                className="text-center text-2xl tracking-widest"
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

            <div className="flex gap-3">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={() => {
                  setStep("phone");
                  setOtp("");
                  clearOtpProgress();
                }}
                disabled={loading}
              >
                Volver
              </Button>
              {/* TRANSICIÓN 4→6: Twilio Verify aún puede generar códigos de 4
                  dígitos; el botón habilita desde 4 hasta que el servicio
                  quede en CodeLength=6. */}
              <Button type="submit" className="flex-1" disabled={otp.length < PHONE_OTP_MIN_LENGTH || loading}>
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Verificando...
                  </>
                ) : (
                  "Verificar"
                )}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
