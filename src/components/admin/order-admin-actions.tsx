"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Send, Webhook, Save, Pencil, Copy, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";

interface OrderAdminActionsProps {
  orderId: string;
  currentStatus: string;
  currentNotes?: string;
  webhookSent: boolean;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  customerCompany?: string | null;
  /**
   * Vista AGENT comercial: oculta webhook y eliminación (capacidades
   * global-admin que el API rechaza con 403).
   */
  agentView?: boolean;
}

export function OrderAdminActions({
  orderId,
  currentStatus,
  currentNotes = "",
  webhookSent,
  customerName,
  customerEmail,
  customerPhone,
  customerCompany,
  agentView = false,
}: OrderAdminActionsProps) {
  const [status, setStatus] = useState(currentStatus);
  const [notes, setNotes] = useState(currentNotes);
  const [loading, setLoading] = useState(false);
  const [savingNotes, setSavingNotes] = useState(false);
  const [webhookLoading, setWebhookLoading] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [savingCustomer, setSavingCustomer] = useState(false);
  const [editForm, setEditForm] = useState({
    customerName: customerName || "",
    customerEmail: customerEmail || "",
    customerPhone: customerPhone || "",
    customerCompany: customerCompany || "",
  });
  const router = useRouter();

  const handleStatusChange = async (newStatus: string) => {
    setStatus(newStatus);
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/orders/${orderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success("Estado actualizado");
        router.refresh();
      } else {
        toast.error(data.error || "Error");
      }
    } catch {
      toast.error("Error de conexión");
    } finally {
      setLoading(false);
    }
  };

  const handleSaveNotes = async () => {
    setSavingNotes(true);
    try {
      const res = await fetch(`/api/admin/orders/${orderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, notes }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success("Notas guardadas");
        router.refresh();
      } else {
        toast.error(data.error || "Error al guardar notas");
      }
    } catch {
      toast.error("Error de conexión");
    } finally {
      setSavingNotes(false);
    }
  };

  const handleSendWebhook = async () => {
    setWebhookLoading(true);
    try {
      const res = await fetch(`/api/orders/${orderId}/webhook`, {
        method: "POST",
      });
      const data = await res.json();
      if (data.success) {
        toast.success("Webhook enviado exitosamente");
        router.refresh();
      } else {
        toast.error(data.message || "Error al enviar webhook");
      }
    } catch {
      toast.error("Error de conexión");
    } finally {
      setWebhookLoading(false);
    }
  };

  const handleSaveCustomer = async () => {
    setSavingCustomer(true);
    try {
      const res = await fetch(`/api/admin/orders/${orderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editForm),
      });
      const data = await res.json();
      if (data.success) {
        toast.success("Datos del cliente actualizados");
        setEditOpen(false);
        router.refresh();
      } else {
        toast.error(data.error || "Error al actualizar");
      }
    } catch {
      toast.error("Error de conexión");
    } finally {
      setSavingCustomer(false);
    }
  };

  const handleDuplicate = async () => {
    setDuplicating(true);
    try {
      const res = await fetch(`/api/admin/orders/${orderId}/duplicate`, {
        method: "POST",
      });
      const data = await res.json();
      if (data.success) {
        toast.success("Pedido duplicado");
        router.push(`/admin/pedidos/${data.data.id}`);
      } else {
        toast.error(data.error || "Error al duplicar");
      }
    } catch {
      toast.error("Error de conexión");
    } finally {
      setDuplicating(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/admin/orders/${orderId}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (data.success) {
        toast.success("Pedido eliminado");
        router.push("/admin/pedidos");
      } else {
        toast.error(data.error || "Error al eliminar");
      }
    } catch {
      toast.error("Error de conexión");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Acciones</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <label className="text-sm text-slate-600 mb-1.5 block">Estado del pedido</label>
          <Select value={status} onValueChange={handleStatusChange} disabled={loading}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="solicitado">Solicitado</SelectItem>
              <SelectItem value="compartido">Compartido</SelectItem>
              <SelectItem value="recibido">Recibido</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label htmlFor="order-notes" className="text-sm text-slate-600 mb-1.5 block">
            Notas internas
          </Label>
          <Textarea
            id="order-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Agregar notas sobre este pedido..."
            rows={3}
            className="text-sm"
          />
          <Button
            size="sm"
            variant="outline"
            className="mt-2 gap-2 w-full"
            onClick={handleSaveNotes}
            disabled={savingNotes}
          >
            <Save className="h-3.5 w-3.5" />
            {savingNotes ? "Guardando..." : "Guardar notas"}
          </Button>
        </div>

        {!agentView && (
          <Button
            className="w-full gap-2"
            variant="outline"
            onClick={handleSendWebhook}
            disabled={webhookLoading}
          >
            <Send className="h-4 w-4" />
            {webhookLoading ? "Enviando..." : webhookSent ? "Reenviar a N8N" : "Enviar a N8N"}
          </Button>
        )}

        {webhookSent && (
          <p className="text-xs text-green-600 flex items-center gap-1">
            <Webhook className="h-3 w-3" />
            Webhook enviado previamente
          </p>
        )}

        <div className="pt-2 border-t border-slate-100 space-y-2">
          {/* Edit customer dialog */}
          <Dialog open={editOpen} onOpenChange={setEditOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="w-full gap-2">
                <Pencil className="h-3.5 w-3.5" />
                Editar datos del cliente
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Editar datos del cliente</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 py-2">
                <div>
                  <Label htmlFor="edit-name">Nombre</Label>
                  <Input
                    id="edit-name"
                    value={editForm.customerName}
                    onChange={(e) => setEditForm((f) => ({ ...f, customerName: e.target.value }))}
                  />
                </div>
                <div>
                  <Label htmlFor="edit-email">Email</Label>
                  <Input
                    id="edit-email"
                    type="email"
                    value={editForm.customerEmail}
                    onChange={(e) => setEditForm((f) => ({ ...f, customerEmail: e.target.value }))}
                  />
                </div>
                <div>
                  <Label htmlFor="edit-phone">Teléfono</Label>
                  <Input
                    id="edit-phone"
                    value={editForm.customerPhone}
                    onChange={(e) => setEditForm((f) => ({ ...f, customerPhone: e.target.value }))}
                  />
                </div>
                <div>
                  <Label htmlFor="edit-company">Empresa</Label>
                  <Input
                    id="edit-company"
                    value={editForm.customerCompany}
                    onChange={(e) => setEditForm((f) => ({ ...f, customerCompany: e.target.value }))}
                  />
                </div>
              </div>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="ghost">Cancelar</Button>
                </DialogClose>
                <Button onClick={handleSaveCustomer} disabled={savingCustomer}>
                  {savingCustomer ? "Guardando..." : "Guardar"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Duplicate */}
          <Button
            variant="outline"
            size="sm"
            className="w-full gap-2"
            onClick={handleDuplicate}
            disabled={duplicating}
          >
            <Copy className="h-3.5 w-3.5" />
            {duplicating ? "Duplicando..." : "Duplicar pedido"}
          </Button>

          {!agentView && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm" className="w-full gap-2">
                  <Trash2 className="h-3.5 w-3.5" />
                  Eliminar pedido
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>¿Eliminar este pedido?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Esta acción no se puede deshacer. Se eliminarán el pedido, sus productos y todo el historial de estados.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancelar</AlertDialogCancel>
                  <AlertDialogAction onClick={handleDelete} disabled={deleting}>
                    {deleting ? "Eliminando..." : "Eliminar"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
