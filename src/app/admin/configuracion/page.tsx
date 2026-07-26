import { redirect } from "next/navigation";
import { getCurrentUser, requireAdminUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Header } from "@/components/admin/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Settings,
  Globe,
  Phone,
  Share2,
  Search,
  Save,
  Store,
  Webhook,
  BookOpen,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { revalidatePath } from "next/cache";

export default async function AdminConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; saved?: string; error?: string }>;
}) {
  const user = await requireAdminUser();

  if (!user) {
    redirect("/admin/login");
  }

  const params = await searchParams;
  const activeTab = params.tab || "general";
  const saved = params.saved === "1";
  const hasError = params.error === "1";

  // Get all settings
  const settings = await db.setting.findMany();
  const settingsMap = settings.reduce((acc, s) => {
    acc[s.key] = s.value;
    return acc;
  }, {} as Record<string, string | null>);

  async function saveSettings(formData: FormData) {
    "use server";

    const currentUser = await requireAdminUser();
    if (!currentUser) throw new Error("No autorizado");

    const group = (formData.get("_group") as string) || "general";
    let redirectPath = `/admin/configuracion?tab=${group}&error=1`;

    try {
      const entries = Array.from(formData.entries());

      for (const [key, value] of entries) {
        if (key === "_group") continue;

        await db.setting.upsert({
          where: { key },
          update: { value: value as string },
          create: { key, value: value as string, group, type: "text" },
        });
      }

      revalidatePath("/admin/configuracion");
      revalidatePath("/");
      redirectPath = `/admin/configuracion?tab=${group}&saved=1`;
    } catch (err) {
      console.error("[saveSettings] Error guardando configuración:", err);
    }

    redirect(redirectPath);
  }

  return (
    <>
      <Header title="Configuración" subtitle="Ajustes generales del sitio" />

      <div className="p-4 sm:p-6">
        {saved && (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            Configuración guardada correctamente.
          </div>
        )}
        {hasError && (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            <AlertCircle className="h-4 w-4 shrink-0" />
            Error al guardar la configuración. Revisa los logs del servidor.
          </div>
        )}

        <Tabs defaultValue={activeTab} className="space-y-6">
          <TabsList className="grid w-full grid-cols-6">
            <TabsTrigger value="general">
              <Store className="h-4 w-4 mr-2" />
              General
            </TabsTrigger>
            <TabsTrigger value="contact">
              <Phone className="h-4 w-4 mr-2" />
              Contacto
            </TabsTrigger>
            <TabsTrigger value="social">
              <Share2 className="h-4 w-4 mr-2" />
              Redes
            </TabsTrigger>
            <TabsTrigger value="seo">
              <Search className="h-4 w-4 mr-2" />
              SEO
            </TabsTrigger>
            <TabsTrigger value="catalog">
              <BookOpen className="h-4 w-4 mr-2" />
              Catálogo
            </TabsTrigger>
            <TabsTrigger value="integrations">
              <Webhook className="h-4 w-4 mr-2" />
              Integraciones
            </TabsTrigger>
          </TabsList>

          {/* General Settings */}
          <TabsContent value="general">
            <Card>
              <CardHeader>
                <CardTitle>Información del sitio</CardTitle>
                <CardDescription>
                  Configuración general del sitio web
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form action={saveSettings} className="space-y-4">
                  <input type="hidden" name="_group" value="general" />
                  
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="site_name">Nombre del sitio</Label>
                      <Input
                        id="site_name"
                        name="site_name"
                        defaultValue={settingsMap.site_name || "Compusum"}
                        placeholder="Compusum"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="primary_color">Color primario</Label>
                      <div className="flex gap-2">
                        <Input
                          id="primary_color"
                          name="primary_color"
                          type="color"
                          defaultValue={settingsMap.primary_color || "#0D4DAA"}
                          className="w-16 h-10 p-1"
                        />
                        <Input
                          defaultValue={settingsMap.primary_color || "#0D4DAA"}
                          placeholder="#0D4DAA"
                          className="flex-1"
                          readOnly
                        />
                      </div>
                    </div>
                  </div>

                  <div className="grid sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="logo_url">URL del logo</Label>
                      <Input
                        id="logo_url"
                        name="logo_url"
                        defaultValue={settingsMap.logo_url || ""}
                        placeholder="https://..."
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="favicon_url">URL del favicon</Label>
                      <Input
                        id="favicon_url"
                        name="favicon_url"
                        defaultValue={settingsMap.favicon_url || ""}
                        placeholder="https://..."
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="footer_text">Texto del footer</Label>
                    <Textarea
                      id="footer_text"
                      name="footer_text"
                      defaultValue={settingsMap.footer_text || ""}
                      placeholder="© 2024 Compusum. Todos los derechos reservados."
                      rows={2}
                    />
                  </div>

                  <Button type="submit" className="bg-primary hover:bg-primary/90">
                    <Save className="h-4 w-4 mr-2" />
                    Guardar configuración
                  </Button>
                </form>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Contact Settings */}
          <TabsContent value="contact">
            <Card>
              <CardHeader>
                <CardTitle>Información de contacto</CardTitle>
                <CardDescription>
                  Datos de contacto que se muestran en el sitio
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form action={saveSettings} className="space-y-4">
                  <input type="hidden" name="_group" value="contact" />
                  
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="whatsapp_global">WhatsApp principal</Label>
                      <Input
                        id="whatsapp_global"
                        name="whatsapp_global"
                        defaultValue={settingsMap.whatsapp_global || ""}
                        placeholder="576063335206"
                      />
                      <p className="text-xs text-slate-500">
                        Número con código de país, sin espacios ni símbolos
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="contact_email_global">Email principal</Label>
                      <Input
                        id="contact_email_global"
                        name="contact_email_global"
                        type="email"
                        defaultValue={settingsMap.contact_email_global || ""}
                        placeholder="info@compusum.co"
                      />
                    </div>
                  </div>

                  <div className="grid sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="phone_number">Teléfono fijo</Label>
                      <Input
                        id="phone_number"
                        name="phone_number"
                        defaultValue={settingsMap.phone_number || ""}
                        placeholder="606 333-5206"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="address_full">Dirección completa</Label>
                      <Input
                        id="address_full"
                        name="address_full"
                        defaultValue={settingsMap.address_full || ""}
                        placeholder="Calle 123 # 45-67, Pereira, Risaralda"
                      />
                    </div>
                  </div>

                  <Button type="submit" className="bg-blue-600 hover:bg-blue-700">
                    <Save className="h-4 w-4 mr-2" />
                    Guardar configuración
                  </Button>
                </form>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Social Settings */}
          <TabsContent value="social">
            <Card>
              <CardHeader>
                <CardTitle>Redes sociales</CardTitle>
                <CardDescription>
                  Enlaces a tus perfiles en redes sociales
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form action={saveSettings} className="space-y-4">
                  <input type="hidden" name="_group" value="social" />
                  
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="facebook_url">Facebook</Label>
                      <Input
                        id="facebook_url"
                        name="facebook_url"
                        defaultValue={settingsMap.facebook_url || ""}
                        placeholder="https://facebook.com/compusum"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="instagram_url">Instagram</Label>
                      <Input
                        id="instagram_url"
                        name="instagram_url"
                        defaultValue={settingsMap.instagram_url || ""}
                        placeholder="https://instagram.com/compusum"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="tiktok_url">TikTok</Label>
                      <Input
                        id="tiktok_url"
                        name="tiktok_url"
                        defaultValue={settingsMap.tiktok_url || ""}
                        placeholder="https://tiktok.com/@compusum"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="linkedin_url">LinkedIn</Label>
                      <Input
                        id="linkedin_url"
                        name="linkedin_url"
                        defaultValue={settingsMap.linkedin_url || ""}
                        placeholder="https://linkedin.com/company/compusum"
                      />
                    </div>
                  </div>

                  <Button type="submit" className="bg-blue-600 hover:bg-blue-700">
                    <Save className="h-4 w-4 mr-2" />
                    Guardar configuración
                  </Button>
                </form>
              </CardContent>
            </Card>
          </TabsContent>

          {/* SEO Settings */}
          <TabsContent value="seo">
            <Card>
              <CardHeader>
                <CardTitle>SEO Global</CardTitle>
                <CardDescription>
                  Configuración de meta tags para buscadores
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form action={saveSettings} className="space-y-4">
                  <input type="hidden" name="_group" value="seo" />

                  <div className="space-y-2">
                    <Label htmlFor="meta_title">Meta título</Label>
                    <Input
                      id="meta_title"
                      name="meta_title"
                      defaultValue={settingsMap.meta_title || ""}
                      placeholder="Compusum | Papelería Mayorista en Pereira"
                    />
                    <p className="text-xs text-slate-500">
                      Máximo 60 caracteres recomendado
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="meta_description">Meta descripción</Label>
                    <Textarea
                      id="meta_description"
                      name="meta_description"
                      defaultValue={settingsMap.meta_description || ""}
                      placeholder="Compusum es tu aliado en suministros de papelería escolar, oficina y arte. Distribuimos a negocios en el Eje Cafetero y Norte del Valle."
                      rows={3}
                    />
                    <p className="text-xs text-slate-500">
                      Máximo 160 caracteres recomendado
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="meta_keywords">Palabras clave</Label>
                    <Input
                      id="meta_keywords"
                      name="meta_keywords"
                      defaultValue={settingsMap.meta_keywords || ""}
                      placeholder="papelería, mayorista, escolar, oficina, Pereira"
                    />
                    <p className="text-xs text-slate-500">
                      Separadas por coma
                    </p>
                  </div>

                  <Button type="submit" className="bg-blue-600 hover:bg-blue-700">
                    <Save className="h-4 w-4 mr-2" />
                    Guardar configuración
                  </Button>
                </form>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Integrations Settings */}
          <TabsContent value="integrations">
            <Card>
              <CardHeader>
                <CardTitle>Integraciones</CardTitle>
                <CardDescription>
                  Configuración de N8N, webhooks y notificaciones de pedidos
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form action={saveSettings} className="space-y-6">
                  <input type="hidden" name="_group" value="integrations" />

                  {/* N8N Webhook */}
                  <div className="space-y-4">
                    <h3 className="text-sm font-semibold text-slate-900 border-b pb-2">
                      Webhook N8N
                    </h3>
                    <div className="space-y-2">
                      <Label htmlFor="n8n_webhook_url">URL del Webhook</Label>
                      <Input
                        id="n8n_webhook_url"
                        name="n8n_webhook_url"
                        defaultValue={settingsMap.n8n_webhook_url || ""}
                        placeholder="https://n8n.compusum.co/webhook/pedidos"
                      />
                      <p className="text-xs text-slate-500">
                        URL donde se enviarán los datos del pedido automáticamente
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="n8n_webhook_enabled">Estado del Webhook</Label>
                      <Select
                        name="n8n_webhook_enabled"
                        defaultValue={settingsMap.n8n_webhook_enabled || "false"}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="true">Activo</SelectItem>
                          <SelectItem value="false">Inactivo</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* Email Notifications */}
                  <div className="space-y-4">
                    <h3 className="text-sm font-semibold text-slate-900 border-b pb-2">
                      Notificaciones por email
                    </h3>
                    <div className="space-y-2">
                      <Label htmlFor="order_notification_email">Email de notificaciones</Label>
                      <Input
                        id="order_notification_email"
                        name="order_notification_email"
                        type="email"
                        defaultValue={settingsMap.order_notification_email || ""}
                        placeholder="pedidos@compusum.co"
                      />
                      <p className="text-xs text-slate-500">
                        Correo donde se recibirán las notificaciones de nuevos pedidos
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="order_email_enabled">Notificaciones por email</Label>
                      <Select
                        name="order_email_enabled"
                        defaultValue={settingsMap.order_email_enabled || "false"}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="true">Activo</SelectItem>
                          <SelectItem value="false">Inactivo</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* WhatsApp for Orders */}
                  <div className="space-y-4">
                    <h3 className="text-sm font-semibold text-slate-900 border-b pb-2">
                      WhatsApp para pedidos
                    </h3>
                    <div className="space-y-2">
                      <Label htmlFor="order_whatsapp_enabled">Enviar pedidos por WhatsApp</Label>
                      <Select
                        name="order_whatsapp_enabled"
                        defaultValue={settingsMap.order_whatsapp_enabled || "true"}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="true">Activo</SelectItem>
                          <SelectItem value="false">Inactivo</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-slate-500">
                        Usa el número de WhatsApp configurado en la pestaña Contacto
                      </p>
                    </div>
                  </div>

                  {/* Callback info */}
                  <div className="bg-slate-50 rounded-lg p-4 space-y-2">
                    <h4 className="text-sm font-medium text-slate-700">URL de callback N8N</h4>
                    <p className="text-xs text-slate-500">
                      Configura esta URL en tu flujo de N8N para confirmar la recepción de pedidos:
                    </p>
                    <code className="text-xs bg-white px-3 py-2 rounded border block text-slate-700 break-all">
                      {`POST /api/webhooks/n8n`}
                    </code>
                    <p className="text-xs text-slate-400">
                      Body: {`{ "orderNumber": "CS-...", "status": "recibido" }`}
                    </p>
                  </div>

                  <Button type="submit" className="bg-blue-600 hover:bg-blue-700">
                    <Save className="h-4 w-4 mr-2" />
                    Guardar configuración
                  </Button>
                </form>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Catalog Mode Settings */}
          <TabsContent value="catalog">
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Modo Catálogo</CardTitle>
                  <CardDescription>
                    Controla la visibilidad global de precios y la capacidad de compra en la tienda.
                    También puedes activar el modo catálogo de forma individual por producto, categoría o marca.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <form action={saveSettings} className="space-y-6">
                    <input type="hidden" name="_group" value="catalog" />

                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 space-y-1">
                      <p className="text-sm font-medium text-amber-800">
                        ¿Qué es el Modo Catálogo?
                      </p>
                      <p className="text-sm text-amber-700">
                        Cuando está activo, los precios se ocultan en toda la tienda y el carrito
                        se convierte en una lista de cotización. Los clientes pueden añadir
                        productos y solicitar cotización sin ver precios.
                      </p>
                    </div>

                    <div className="space-y-4">
                      <h3 className="text-sm font-semibold text-slate-900 border-b pb-2">
                        Configuración global
                      </h3>

                      <div className="flex items-center justify-between">
                        <div>
                          <Label htmlFor="catalog_mode_enabled">Modo Catálogo global</Label>
                          <p className="text-xs text-slate-500 mt-0.5">
                            Activa el modo catálogo para toda la tienda
                          </p>
                        </div>
                        <Select
                          name="catalog_mode_enabled"
                          defaultValue={settingsMap.catalog_mode_enabled || "false"}
                        >
                          <SelectTrigger className="w-32">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="true">Activo</SelectItem>
                            <SelectItem value="false">Inactivo</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="catalog_mode_message">
                          Mensaje de modo catálogo
                        </Label>
                        <Input
                          id="catalog_mode_message"
                          name="catalog_mode_message"
                          defaultValue={
                            settingsMap.catalog_mode_message ||
                            "Solicita tu cotización personalizada"
                          }
                          placeholder="Solicita tu cotización personalizada"
                        />
                        <p className="text-xs text-slate-500">
                          Texto que se muestra en lugar del precio cuando el modo catálogo está activo
                        </p>
                      </div>

                      <div className="flex items-center justify-between">
                        <div>
                          <Label htmlFor="cross_sell_enabled">Sugerencias en carrito (Cross-sell)</Label>
                          <p className="text-xs text-slate-500 mt-0.5">
                            Muestra productos relacionados automáticamente en el carrito y en el estado vacío
                          </p>
                        </div>
                        <Select
                          name="cross_sell_enabled"
                          defaultValue={settingsMap.cross_sell_enabled || "true"}
                        >
                          <SelectTrigger className="w-32">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="true">Activo</SelectItem>
                            <SelectItem value="false">Inactivo</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    <Button type="submit" className="bg-blue-600 hover:bg-blue-700">
                      <Save className="h-4 w-4 mr-2" />
                      Guardar configuración
                    </Button>
                  </form>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">¿Cómo funciona el cross-sell?</CardTitle>
                  <CardDescription>
                    Las sugerencias de productos se generan automáticamente
                  </CardDescription>
                </CardHeader>
                <CardContent className="text-sm text-slate-600 space-y-2">
                  <p>
                    • <strong>Carrito con productos:</strong> Muestra hasta 3 productos de la misma categoría que el primer ítem en el carrito, excluyendo los ya agregados.
                  </p>
                  <p>
                    • <strong>Carrito vacío:</strong> Muestra hasta 4 productos destacados para inspirar al comprador.
                  </p>
                  <p>
                    • Para marcar un producto como destacado, edítalo en{" "}
                    <a href="/admin/productos" className="text-blue-600 hover:underline">
                      Productos
                    </a>{" "}
                    y activa la opción <strong>Destacado</strong>.
                  </p>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}
