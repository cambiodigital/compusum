import { describe, it, expect } from 'vitest';
import { isAdminRole, isBackofficeRole, isAgentRole, ADMIN_ROLES } from '@/lib/auth';

describe('RBAC Authorization Rules', () => {
  describe('isAdminRole (global administration: admin/editor only)', () => {
    it('returns true for global admin roles', () => {
      expect(isAdminRole('admin')).toBe(true);
      expect(isAdminRole('editor')).toBe(true);
    });

    it('is case-insensitive and handles whitespace', () => {
      expect(isAdminRole(' ADMIN ')).toBe(true);
      expect(isAdminRole('Editor')).toBe(true);
    });

    it('returns false for AGENT and non-admin roles', () => {
      expect(isAdminRole('AGENT')).toBe(false);
      expect(isAdminRole('agent')).toBe(false);
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

  describe('isBackofficeRole (admin panel access: admin/editor/AGENT)', () => {
    it('returns true for backoffice roles', () => {
      expect(isBackofficeRole('admin')).toBe(true);
      expect(isBackofficeRole('editor')).toBe(true);
      expect(isBackofficeRole('AGENT')).toBe(true);
    });

    it('is case-insensitive and handles whitespace', () => {
      expect(isBackofficeRole(' ADMIN ')).toBe(true);
      expect(isBackofficeRole('Editor')).toBe(true);
      expect(isBackofficeRole(' agent ')).toBe(true);
    });

    it('returns false for non-backoffice roles and invalid values', () => {
      expect(isBackofficeRole('CUSTOMER')).toBe(false);
      expect(isBackofficeRole('customer')).toBe(false);
      expect(isBackofficeRole('user')).toBe(false);
      expect(isBackofficeRole('guest')).toBe(false);
      expect(isBackofficeRole('')).toBe(false);
      expect(isBackofficeRole(null)).toBe(false);
      expect(isBackofficeRole(undefined)).toBe(false);
    });
  });

  describe('isAgentRole (commercial agent only)', () => {
    it('returns true only for AGENT in any casing', () => {
      expect(isAgentRole('AGENT')).toBe(true);
      expect(isAgentRole('agent')).toBe(true);
      expect(isAgentRole(' Agent ')).toBe(true);
    });

    it('returns false for admin/editor/customer and invalid values', () => {
      expect(isAgentRole('admin')).toBe(false);
      expect(isAgentRole('editor')).toBe(false);
      expect(isAgentRole('CUSTOMER')).toBe(false);
      expect(isAgentRole('')).toBe(false);
      expect(isAgentRole(null)).toBe(false);
      expect(isAgentRole(undefined)).toBe(false);
    });
  });
});
