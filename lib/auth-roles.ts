export const ADMIN_EMAIL = 'anpa23co@gmail.com';

export function hasAdminAccess(
  email: string | null | undefined,
  _emailVerified: boolean,
  role: unknown,
) {
  return role === 'admin' || email?.trim().toLowerCase() === ADMIN_EMAIL;
}
