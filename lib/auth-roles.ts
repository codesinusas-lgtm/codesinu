export const ADMIN_EMAIL = 'admin@code-sinu';

export function hasAdminAccess(
  email: string | null | undefined,
  _emailVerified: boolean,
  role: unknown,
) {
  return role === 'admin' || email?.trim().toLowerCase() === ADMIN_EMAIL;
}
