export const RESERVED_HANDLES = new Set(['admin', 'root', 'support', 'help', 'bank', 'upi', 'npci', 'kosh', 'alpha', 'beta', 'null', 'test', 'system', 'switch']);

export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9._-]{2,29}$/;

export const MAX_VPAS_PER_USER = 5;

export function handleProblem(handle: string): string | null {
  if (!HANDLE_PATTERN.test(handle)) return 'handle must be 3-30 lowercase letters, digits, dot, dash or underscore and start with a letter or digit';
  if (/[._-]{2}/.test(handle)) return 'handle cannot contain consecutive separators';
  if (/[._-]$/.test(handle)) return 'handle cannot end with a separator';
  if (RESERVED_HANDLES.has(handle)) return 'handle is reserved';
  if (/^\d{10}$/.test(handle) === false && /^\d+$/.test(handle)) return 'numeric handles must be a 10 digit mobile number';
  return null;
}

export function parseAddress(address: string): { handle: string; psp: string } | null {
  const m = /^([a-z0-9._-]+)@([a-z0-9]+)$/.exec(address.toLowerCase());
  if (!m) return null;
  return { handle: m[1]!, psp: m[2]! };
}

export function maskName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  const [first, ...rest] = parts;
  return [first, ...rest.map((p) => p[0]!.toUpperCase())].join(' ');
}
