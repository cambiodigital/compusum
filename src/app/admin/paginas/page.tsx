import { redirect } from "next/navigation";
import { getCurrentUser, requireAdminUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Header } from "@/components/admin/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import Link from "next/link";
import {
  FileText,
  ExternalLink,
  Save,
} from "lucide-react";
import { revalidatePath } from "next/cache";

export default async function AdminPagesPage() {
  const user = await requireAdminUser();

  if (!user) {
    redirect("/admin/login");
  }

  // Get settings for contact page
  const settings = await db.setting.findMany({
    where: {
      group: "contact",
    },
  });

  const settingsMap = settings.reduce((acc, s) => {
    acc[s.key] = s.value;
    return acc;
  }, {} as Record<string, string | null>);

  async function saveContactSettings(formData: FormData) {
    "use server";
    
    const currentUser = await requireAdminUser();
    if (!currentUser) throw new Error("No autorizado");
    
    const fields = [
      "whatsapp_number",
      "contact_email",
      "address",
      "city",
      "contact_intro",
      "business_hours",
    ];

    for (const field of fields) {
      const value = formData.get(field) as string;
      await db.setting.upsert({
        where: { key: field },
        update: { value, group: "contact" },
        create: { key: field, value, group: "contact", type: "text" },
      });
    }

    revalidatePath("/admin/paginas");
    revalidatePath("/contacto");
  }

  return (
    <>
      <Header title="Páginas" subtitle="Gestiona el contenido de las páginas estáticas" />

      <div className="p-4 sm:p-6 space-y-6">
        {/* Contact Page */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg flex items-center gap-2">
                  <FileText className="h-5 w-5" />
                  Página de Contacto
                </CardTitle>
                <CardDescription>
                  Información que se muestra en la página de contacto
                </CardDescription>
              </div>
              <Button variant="outline" size="sm" asChild>
                <Link href="/contacto" target="_blank">
                  <ExternalLink className="h-4 w-4 mr-2" />
                  Ver página
                </Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <form action={saveContactSettings} className="space-y-4">
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="whatsapp_number">Número de WhatsApp</Label>
                  <Input
                    id="whatsapp_number"
                    name="whatsapp_number"
                    defaultValue={settingsMap.whatsapp_number || ""}
                    placeholder="606 333-5206"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="contact_email">Email de contacto</Label>
                  <Input
                    id="contact_email"
                    name="contact_email"
                    type="email"
                    defaultValue={settingsMap.contact_email || ""}
                    placeholder="info@compusum.co"
                  />
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="address">Dirección</Label>
                  <Input
                    id="address"
                    name="address"
                    defaultValue={settingsMap.address || ""}
                    placeholder="Calle 123 # 45-67"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="city">Ciudad / Departamento</Label>
                  <Input
                    id="city"
                    name="city"
                    defaultValue={settingsMap.city || ""}
                    placeholder="Pereira, Risaralda"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="contact_intro">Texto de introducción</Label>
                <Textarea
                  id="contact_intro"
                  name="contact_intro"
                  defaultValue={settingsMap.contact_intro || ""}
                  placeholder="Texto de bienvenida en la página de contacto..."
                  rows={3}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="business_hours">Horarios de atención</Label>
                <Textarea
                  id="business_hours"
                  name="business_hours"
                  defaultValue={settingsMap.business_hours || ""}
                  placeholder="Lunes a Viernes: 8:00 AM - 6:00 PM&#10;Sábados: 9:00 AM - 1:00 PM"
                  rows={3}
                />
              </div>

              <Button type="submit" className="bg-blue-600 hover:bg-blue-700">
                <Save className="h-4 w-4 mr-2" />
                Guardar cambios
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Wholesalers Page */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg flex items-center gap-2">
                  <FileText className="h-5 w-5" />
                  Página "¿Eres Mayorista?"
                </CardTitle>
                <CardDescription>
                  Información para clientes mayoristas
                </CardDescription>
              </div>
              <Button variant="outline" size="sm" asChild>
                <Link href="/mayoristas" target="_blank">
                  <ExternalLink className="h-4 w-4 mr-2" />
                  Ver página
                </Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-slate-500 text-sm">
              Esta página muestra información sobre los beneficios de ser cliente mayorista.
              El contenido se gestiona desde la sección de Configuración.
            </p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
