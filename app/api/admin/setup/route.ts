import { timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { ADMIN_EMAIL } from '@/lib/auth-roles';

export const runtime = 'nodejs';

function json(body: Record<string, string>, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function tokenMatches(provided: string, expected: string) {
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes);
}

export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) {
    return json({ error: 'Solicitud no válida.' }, 403);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  const expectedToken = process.env.ADMIN_SETUP_TOKEN?.trim();
  if (!url || !secretKey || !secretKey.startsWith('sb_secret_') || secretKey.toLowerCase().includes('replace')
    || !expectedToken || !/^[A-Za-z0-9_-]{43}$/.test(expectedToken)) {
    return json({ error: 'Configura en el servidor una sb_secret_ real de Supabase y un ADMIN_SETUP_TOKEN aleatorio de 43 caracteres.' }, 503);
  }

  let body: { token?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Solicitud no válida.' }, 400);
  }
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!tokenMatches(token, expectedToken)) return json({ error: 'Código de configuración incorrecto.' }, 401);
  if (password.length < 12 || password.length > 128) {
    return json({ error: 'La nueva contraseña debe tener entre 12 y 128 caracteres.' }, 400);
  }

  const supabaseAdmin = createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });

  try {
    let existingUser = null as Awaited<ReturnType<typeof supabaseAdmin.auth.admin.getUserById>>['data']['user'];
    for (let page = 1; page <= 50; page += 1) {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) return json({ error: 'No se pudo consultar Supabase Authentication.' }, 502);
      existingUser = data.users.find(user => user.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase()) || null;
      if (existingUser || data.users.length < 1000) break;
    }

    if (existingUser?.app_metadata?.sinucode_admin_setup_complete === true) {
      return json({ error: 'El acceso de administrador ya fue configurado. Inicia sesión con la contraseña elegida.' }, 409);
    }

    const appMetadata = {
      ...(existingUser?.app_metadata || {}),
      role: 'admin',
      sinucode_admin_setup_complete: true,
    };
    const { error } = existingUser
      ? await supabaseAdmin.auth.admin.updateUserById(existingUser.id, {
        password,
        email_confirm: true,
        app_metadata: appMetadata,
      })
      : await supabaseAdmin.auth.admin.createUser({
        email: ADMIN_EMAIL,
        password,
        email_confirm: true,
        app_metadata: appMetadata,
      });

    if (error) return json({ error: 'Supabase no pudo crear o configurar la cuenta administradora.' }, 502);
    return json({ message: 'Acceso administrador configurado.' });
  } catch {
    return json({ error: 'No se pudo completar la configuración con Supabase.' }, 502);
  }
}
