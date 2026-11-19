import type { Request } from 'express';
import { HEADERS, PrincipalSchema, type Principal, type Role } from '@kosh/contracts';
import { forbidden, unauthorized } from './errors.ts';

export type Caller =
  | { kind: 'user'; principal: Principal }
  | { kind: 'service'; name: string }
  | { kind: 'anonymous' };

export function encodePrincipal(p: Principal): string {
  return Buffer.from(JSON.stringify(p), 'utf8').toString('base64url');
}

export function decodePrincipal(raw: string): Principal {
  return PrincipalSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
}

export function getCaller(req: Request): Caller {
  const callerName = req.header(HEADERS.caller) ?? '';
  const rawPrincipal = req.header(HEADERS.principal);
  if (rawPrincipal) {
    try {
      return { kind: 'user', principal: decodePrincipal(rawPrincipal) };
    } catch {
      throw unauthorized('PRINCIPAL_INVALID', 'principal header could not be decoded');
    }
  }
  if (callerName && callerName !== 'gateway') return { kind: 'service', name: callerName };
  return { kind: 'anonymous' };
}

export function requireUser(req: Request): Principal {
  const c = getCaller(req);
  if (c.kind !== 'user') throw unauthorized('AUTH_REQUIRED', 'authentication required');
  return c.principal;
}

export function requireCustomer(req: Request): Principal {
  const p = requireUser(req);
  if (p.kind !== 'customer') throw forbidden('CUSTOMER_ONLY', 'this action is only available to customers');
  return p;
}

export function hasRole(p: Principal, roles: readonly Role[]): boolean {
  return p.roles.includes('ADMIN') || roles.some((r) => p.roles.includes(r));
}

export function requireStaff(req: Request, roles: readonly Role[] = []): Principal {
  const p = requireUser(req);
  if (p.kind !== 'staff') throw forbidden('STAFF_ONLY', 'this action is only available to staff');
  if (roles.length > 0 && !hasRole(p, roles)) throw forbidden('ROLE_REQUIRED', `requires one of: ${roles.join(', ')}`);
  return p;
}

export function requireServiceOrStaff(req: Request, roles: readonly Role[]): Caller {
  const c = getCaller(req);
  if (c.kind === 'service') return c;
  requireStaff(req, roles);
  return c;
}

export function assertBankScope(p: Principal, bankCode: string): void {
  if (p.roles.includes('ADMIN') || p.roles.includes('SWITCH_OPS')) return;
  if (p.bankCode !== bankCode) throw forbidden('BANK_SCOPE', `staff of ${p.bankCode ?? 'no bank'} cannot act on ${bankCode}`);
}
