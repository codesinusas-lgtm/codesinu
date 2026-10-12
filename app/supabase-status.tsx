'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, LoaderCircle, RefreshCw, WifiOff } from 'lucide-react';
import { checkSupabaseHealth } from '@/lib/supabase/health';

type ConnectionState = 'checking' | 'connected' | 'offline' | 'error';

export default function SupabaseStatus() {
  const [state, setState] = useState<ConnectionState>('checking');
  const [detail, setDetail] = useState('');
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  const check = useCallback(async () => {
    if (!navigator.onLine) {
      setState('offline');
      setDetail('Los cambios nuevos se guardan localmente y esperan conexión.');
      return;
    }
    const result = await checkSupabaseHealth();
    setState(result.connected ? 'connected' : 'error');
    setDetail(result.detail || 'Conexión con Supabase verificada.');
    setCheckedAt(Date.now());
  }, []);

  useEffect(() => {
    let active = true;
    const runCheck = async () => {
      if (!navigator.onLine) {
        if (active) {
          setState('offline');
          setDetail('Los cambios nuevos se guardan localmente y esperan conexión.');
        }
        return;
      }
      const result = await checkSupabaseHealth();
      if (!active) return;
      setState(result.connected ? 'connected' : 'error');
      setDetail(result.detail || 'Conexión con Supabase verificada.');
      setCheckedAt(Date.now());
    };
    const onOnline = () => { void runCheck(); };
    const onOffline = () => {
      setState('offline');
      setDetail('Los cambios nuevos se guardan localmente y esperan conexión.');
    };
    const onVisible = () => { if (document.visibilityState === 'visible') void runCheck(); };

    void runCheck();
    const interval = window.setInterval(() => { void runCheck(); }, 20_000);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const Icon = state === 'connected' ? CheckCircle2
    : state === 'offline' ? WifiOff
      : state === 'error' ? AlertCircle
        : LoaderCircle;
  const label = state === 'connected' ? `Supabase conectado${checkedAt ? ` · ${new Date(checkedAt).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}` : ''}`
    : state === 'offline' ? 'Sin internet · guardado local'
    : state === 'error' ? detail || 'Supabase no disponible'
        : 'Verificando Supabase…';

  return <aside className={`supabase-connection ${state}`} role="status" aria-live="polite" title={detail}>
    <Icon size={16} className={state === 'checking' ? 'connection-spin' : ''} />
    <span>{label}</span>
    <button type="button" onClick={() => void check()} aria-label="Comprobar conexión con Supabase" title="Comprobar ahora">
      {state === 'checking' ? <LoaderCircle size={14} className="connection-spin" /> : <RefreshCw size={14} />}
    </button>
  </aside>;
}
