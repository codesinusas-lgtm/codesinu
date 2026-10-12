export type SupabaseHealth = {
  connected: boolean;
  detail?: string;
};

export async function checkSupabaseHealth(): Promise<SupabaseHealth> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/+$/, '') || '';
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() || '';
  if (!url || !key) return { connected: false, detail: 'Faltan las variables públicas de Supabase.' };

  try {
    const response = await fetch(`${url}/rest/v1/workers?select=uid&limit=1`, {
      method: 'GET',
      headers: { apikey: key, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (response.ok) return { connected: true };

    const payload = await response.json().catch(() => ({})) as { code?: string; message?: string };
    if (payload.code === 'PGRST205') {
      return { connected: false, detail: 'No se encuentra public.workers. Ejecuta la migración de Supabase y recarga su esquema.' };
    }
    if (response.status === 401 && payload.message?.toLowerCase().includes('invalid api key')) {
      return { connected: false, detail: 'Supabase rechazó la publishable key. En Vercel → Settings → Environment Variables, copia la key actual de Project Settings → API Keys del mismo proyecto que la URL y vuelve a desplegar.' };
    }
    if (response.status === 401 || response.status === 403 || payload.code === '42501') {
      return { connected: false, detail: 'Supabase rechazó la lectura pública de trabajadores. Aplica la migración SQL y revisa los permisos RLS.' };
    }
    return { connected: false, detail: `Supabase respondió HTTP ${response.status}.` };
  } catch {
    return { connected: false, detail: 'No se pudo alcanzar la API de Supabase.' };
  }
}
