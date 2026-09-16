"use client";

import { useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Upload, Loader2 } from "lucide-react";
import { extractFirstUploadedUrl } from "@/lib/upload-response";

interface ImageUploadProps {
  value: string;
  onChange: (url: string) => void;
  label?: string;
  placeholder?: string;
}

export function ImageUpload({ value, onChange, label, placeholder = "https://..." }: ImageUploadProps) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError("");
    setUploading(true);

    try {
      const form = new FormData();
      form.append("file", file);

      const res = await fetch("/api/admin/upload", { method: "POST", body: form });
      const data = await res.json();

      // Contrato F6A: la respuesta expone data.uploaded[] (no data.url).
      // El parser es fail-closed: sin URL válida muestra error y NUNCA
      // invoca onChange con un valor vacío.
      const extraction = extractFirstUploadedUrl(data);
      if (!extraction.ok) {
        setError(extraction.error);
        return;
      }

      onChange(extraction.url);
    } catch {
      setError("Error de conexión al subir imagen");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="space-y-2">
      {label && <Label>{label}</Label>}

      <div className="flex gap-2">
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="flex-1"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="shrink-0"
        >
          {uploading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Upload className="h-4 w-4" />
          )}
          <span className="ml-2 hidden sm:inline">Subir</span>
        </Button>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        className="hidden"
        onChange={handleFile}
      />

      {error && <p className="text-xs text-red-500">{error}</p>}

      {value && (
        <div className="w-24 h-24 rounded-lg overflow-hidden border border-slate-200 bg-slate-50 flex items-center justify-center">
          <img
            src={value}
            alt="Preview"
            className="max-w-full max-h-full object-contain"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        </div>
      )}
    </div>
  );
}
