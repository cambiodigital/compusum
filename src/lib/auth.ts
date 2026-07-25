import bcrypt from 'bcryptjs';
import { db } from './db';
import { cookies } from 'next/headers';

const SALT_ROUNDS = 10;
const SESSION_COOKIE_NAME = 'session_token';
export const SESSION_DURATION_HOURS_DEFAULT = 24;
export const SESSION_DURATION_DAYS_REMEMBER_ME = 30;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hashedPassword: string): Promise<boolean> {
  return bcrypt.compare(password, hashedPassword);
}

export function generateToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function createSession(
  userId: string,
  durationHours: number = SESSION_DURATION_HOURS_DEFAULT
): Promise<string> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + durationHours * 60 * 60 * 1000);

  await db.session.create({
    data: { token, userId, expiresAt },
  });

  return token;
}

export async function getSession(token: string): Promise<{ userId: string } | null> {
  const session = await db.session.findUnique({
    where: { token },
  });

  if (!session) return null;

  if (session.expiresAt < new Date()) {
    await db.session.delete({ where: { token } });
    return null;
  }

  return { userId: session.userId };
}

export async function deleteSession(token: string): Promise<void> {
  await db.session.deleteMany({ where: { token } });
}

export async function getCurrentUser(): Promise<{
  id: string;
  name: string;
  email: string;
  role: string;
} | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  
  if (!token) return null;
  
  const session = await getSession(token);
  if (!session) return null;
  
  const user = await db.user.findUnique({
    where: { id: session.userId },
    select: { id: true, name: true, email: true, role: true, isActive: true },
  });
  
  if (!user || !user.isActive) return null;
  
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
  };
}

export async function setSessionCookie(
  token: string,
  maxAgeSeconds: number = SESSION_DURATION_HOURS_DEFAULT * 60 * 60
): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: maxAgeSeconds,
    path: '/',
  });
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE_NAME);
}

export async function rotateGuestSessionCookie(): Promise<string> {
  const newSessionId = crypto.randomUUID();
  const cookieStore = await cookies();
  cookieStore.set('x-session-id', newSessionId, {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60,
    path: '/',
  });
  return newSessionId;
}

export const SESSION_COOKIE_NAME_EXPORT = SESSION_COOKIE_NAME;

