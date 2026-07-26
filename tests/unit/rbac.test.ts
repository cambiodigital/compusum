import { describe, it, expect, vi } from 'vitest';
import { isAdminRole, ADMIN_ROLES } from '@/lib/auth';

describe('RBAC Authorization Rules', () => {
  describe('isAdminRole', () => {
    it('returns true for defined admin roles', () => {
      expect(isAdminRole('admin')).toBe(true);
      expect(isAdminRole('editor')).toBe(true);
      expect(isAdminRole('AGENT')).toBe(true);
    });

    it('is case-insensitive and handles whitespace', () => {
      expect(isAdminRole(' ADMIN ')).toBe(true);
      expect(isAdminRole('Editor')).toBe(true);
      expect(isAdminRole('agent')).toBe(true);
    });

    it('returns false for non-admin roles and invalid values', () => {
      expect(isAdminRole('CUSTOMER')).toBe(false);
      expect(isAdminRole('user')).toBe(false);
      expect(isAdminRole('guest')).toBe(false);
      expect(isAdminRole('')).toBe(false);
      expect(isAdminRole(null)).toBe(false);
      expect(isAdminRole(undefined)).toBe(false);
    });

    it('matches ADMIN_ROLES list contents', () => {
      ADMIN_ROLES.forEach((role) => {
        expect(isAdminRole(role)).toBe(true);
      });
    });
  });
});
