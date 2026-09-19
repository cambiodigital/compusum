import { db } from "./db";
import { hashPassword } from "./auth";
import { Prisma } from "@prisma/client";
import { normalizeCustomerEmail } from "./customer-auth";
import { canonicalColombiaPhone, phoneOrVariants } from "./phone";

/**
 * Maestro de clientes sobre `User` (role CUSTOMER) — lógica compartida por
 * las rutas /api/admin/customers y las páginas /admin/clientes.
 */

export class CustomerAdminError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CustomerAdminError";
    this.code = code;
  }
}

export const CUSTOMER_ROLE = "CUSTOMER";

function normalizeAgentRole(role: string): boolean {
  return role?.trim().toLowerCase() === "agent";
}

/** Un asesor asignable debe ser un usuario ACTIVO con rol AGENT. */
export async function validateAgentAssignment(
  agentId: string | null | undefined,
  tx: any = db
): Promise<void> {
  if (!agentId) return;
  const agent = await tx.user.findUnique({
    where: { id: agentId },
    select: { role: true, isActive: true },
  });
  if (!agent || !normalizeAgentRole(agent.role)) {
    throw new CustomerAdminError(
      "INVALID_AGENT",
      "El asesor asignado no existe o no tiene rol AGENT."
    );
  }
  if (!agent.isActive) {
    throw new CustomerAdminError("INACTIVE_AGENT", "El asesor está inactivo y no puede asignarse.");
  }
}

/** El perfil de precio asignado debe existir y estar activo. */
export async function validateProfileAssignment(
  profileId: string | null | undefined,
  tx: any = db
): Promise<void> {
  if (!profileId) return;
  const profile = await tx.priceProfile.findUnique({
    where: { id: profileId },
    select: { isActive: true },
  });
  if (!profile) {
    throw new CustomerAdminError("INVALID_PROFILE", "El perfil de precio no existe.");
  }
  if (!profile.isActive) {
    throw new CustomerAdminError(
      "INACTIVE_PROFILE",
      "El perfil de precio está inactivo y no puede asignarse."
    );
  }
}

export interface CustomerInput {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  taxId?: string | null;
  address?: string | null;
  city?: string | null;
  notes?: string | null;
  isActive?: boolean;
  assignedAgentId?: string | null;
  priceProfileId?: string | null;
  password?: string | null;
}

/**
 * Normaliza el teléfono de entrada a formato canónico. El teléfono sigue
 * OBLIGATORIO en cuentas nuevas: con la unificación de auth el correo también
 * permite recuperación autónoma (OTP por Resend), pero el teléfono es el canal
 * alternativo cuando el cliente no tiene correo (SMS vía Twilio).
 */
function requireCanonicalPhone(phone?: string | null): string {
  const canonical = canonicalColombiaPhone(phone);
  if (!canonical) {
    throw new CustomerAdminError(
      "INVALID_PHONE",
      "El teléfono es obligatorio y debe ser un número colombiano de 10 dígitos."
    );
  }
  return canonical;
}

export async function createCustomerAccount(input: CustomerInput, tx: any = db) {
  const name = input.name?.trim().slice(0, 200);
  const email = normalizeCustomerEmail(input.email);
  const phone = requireCanonicalPhone(input.phone);

  if (!name) {
    throw new CustomerAdminError("INVALID_NAME", "El nombre es requerido.");
  }

  await validateAgentAssignment(input.assignedAgentId, tx);
  await validateProfileAssignment(input.priceProfileId, tx);

  const existing = await tx.user.findFirst({
    where: { OR: [...(email ? [{ email }] : []), ...phoneOrVariants(phone)] },
    select: { id: true },
  });
  if (existing) {
    throw new CustomerAdminError(
      "ACCOUNT_EXISTS",
      "Ya existe una cuenta con ese correo o teléfono."
    );
  }

  const password =
    input.password && input.password.length >= 8
      ? await hashPassword(input.password)
      : await hashPassword(generateTemporaryPassword());

  return tx.user.create({
    data: {
      name,
      email,
      phone,
      company: input.company?.trim().slice(0, 200) || null,
      taxId: input.taxId?.trim().slice(0, 50) || null,
      address: input.address?.trim().slice(0, 300) || null,
      city: input.city?.trim().slice(0, 100) || null,
      notes: input.notes?.trim().slice(0, 2000) || null,
      isActive: input.isActive ?? true,
      role: CUSTOMER_ROLE,
      password,
      assignedAgentId: input.assignedAgentId || null,
      priceProfileId: input.priceProfileId || null,
    },
    include: {
      assignedAgent: { select: { id: true, name: true, email: true } },
      priceProfile: { select: { id: true, name: true, code: true } },
    },
  }).then(stripPassword);
}

/**
 * Nunca exponer hash de contraseña ni marcas internas en respuestas de la
 * API (las relaciones assignedAgent/priceProfile sí son datos del maestro).
 */
function stripPassword(user: any) {
  if (!user) return user;
  const { password, passwordChangedAt, sessions, ...safe } = user;
  return safe;
}

function generateTemporaryPassword(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function updateCustomerAccount(
  id: string,
  input: CustomerInput,
  tx: any = db
) {
  const current = await tx.user.findUnique({ where: { id } });
  if (!current || current.role.toLowerCase() !== "customer") {
    throw new CustomerAdminError("NOT_FOUND", "Cliente no encontrado.");
  }

  const data: Record<string, unknown> = {};

  if (input.name !== undefined) {
    const name = input.name?.trim().slice(0, 200);
    if (!name) throw new CustomerAdminError("INVALID_NAME", "El nombre es requerido.");
    data.name = name;
  }

  const email = normalizeCustomerEmail(input.email);
  // El teléfono NO puede eliminarse: sin teléfono la cuenta pierde su única
  // vía de recuperación autónoma (OTP). Un teléfono inválido se rechaza.
  let phone: string | null = null;
  if (input.phone !== undefined && input.phone !== null) {
    const canonical = canonicalColombiaPhone(input.phone);
    if (!canonical) {
      throw new CustomerAdminError(
        "INVALID_PHONE",
        "El teléfono debe ser un número colombiano de 10 dígitos."
      );
    }
    phone = canonical;
    data.phone = canonical;
  }
  if (!email && !phone && input.email !== undefined && input.phone !== undefined) {
    if (input.email === null) {
      throw new CustomerAdminError(
        "CONTACT_REQUIRED",
        "El cliente debe conservar un correo o un teléfono."
      );
    }
  }
  if (email !== null) data.email = email;

  if (input.company !== undefined) data.company = input.company?.trim().slice(0, 200) || null;
  if (input.taxId !== undefined) data.taxId = input.taxId?.trim().slice(0, 50) || null;
  if (input.address !== undefined) data.address = input.address?.trim().slice(0, 300) || null;
  if (input.city !== undefined) data.city = input.city?.trim().slice(0, 100) || null;
  if (input.notes !== undefined) data.notes = input.notes?.trim().slice(0, 2000) || null;
  if (input.isActive !== undefined) data.isActive = input.isActive;

  if (input.assignedAgentId !== undefined) {
    await validateAgentAssignment(input.assignedAgentId || null, tx);
    data.assignedAgentId = input.assignedAgentId || null;
  }

  if (input.priceProfileId !== undefined) {
    await validateProfileAssignment(input.priceProfileId || null, tx);
    data.priceProfileId = input.priceProfileId || null;
  }

  if (input.password) {
    if (input.password.length < 8) {
      throw new CustomerAdminError("WEAK_PASSWORD", "La contraseña debe tener al menos 8 caracteres.");
    }
    data.password = await hashPassword(input.password);
    data.passwordChangedAt = new Date();
  }

  // Unicidad email/teléfono (cualquier forma equivalente) excluyendo al propio cliente
  const nextEmail = data.email ?? current.email;
  const nextPhone = data.phone ?? current.phone;
  const duplicate = await tx.user.findFirst({
    where: {
      id: { not: id },
      OR: [...(nextEmail ? [{ email: nextEmail }] : []), ...phoneOrVariants(nextPhone)],
    },
    select: { id: true },
  });
  if (duplicate) {
    throw new CustomerAdminError(
      "ACCOUNT_EXISTS",
      "Otro usuario ya usa ese correo o teléfono."
    );
  }

  try {
    return await tx.user.update({
      where: { id },
      data,
      include: {
        assignedAgent: { select: { id: true, name: true, email: true } },
        priceProfile: { select: { id: true, name: true, code: true } },
      },
    }).then(stripPassword);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new CustomerAdminError("ACCOUNT_EXISTS", "Otro usuario ya usa ese correo o teléfono.");
    }
    throw error;
  }
}

/**
 * Eliminación segura: si el cliente tiene pedidos se rechaza (el histórico de
 * pedidos debe conservar su enlace); se sugiere desactivar la cuenta.
 */
export async function deleteCustomerAccount(id: string, tx: any = db) {
  const current = await tx.user.findUnique({
    where: { id },
    include: { _count: { select: { orders: true } } },
  });
  if (!current || current.role.toLowerCase() !== "customer") {
    throw new CustomerAdminError("NOT_FOUND", "Cliente no encontrado.");
  }
  if (current._count.orders > 0) {
    throw new CustomerAdminError(
      "HAS_ORDERS",
      `El cliente tiene ${current._count.orders} pedido(s) asociado(s). Desactiva la cuenta en lugar de eliminarla.`
    );
  }

  await tx.session.deleteMany({ where: { userId: id } });
  await tx.user.delete({ where: { id } });
}

/** Lista de asesores activos para los selectores de administración. */
export async function listActiveAgents(tx: any = db) {
  return tx.user.findMany({
    where: { isActive: true, role: { equals: "AGENT", mode: "insensitive" } },
    select: { id: true, name: true, email: true, phone: true },
    orderBy: { name: "asc" },
  });
}

/** Perfiles de precio activos para los selectores de administración. */
export async function listActivePriceProfiles(tx: any = db) {
  return tx.priceProfile.findMany({
    where: { isActive: true },
    select: { id: true, name: true, code: true },
    orderBy: { name: "asc" },
  });
}
