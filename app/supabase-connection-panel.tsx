'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Cloud, LoaderCircle, RefreshCw, WifiOff } from 'lucide-react';
import { checkSupabaseHealth } from '@/lib/supabase/health';

type ConnectionState = 'checking' | 'connected' | 'offline' | 'error';

export default function SupabaseConnectionPanel() {
  const [state, setState] = useState<ConnectionState>('checking');
  const [detail, setDetail] = useState('');
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  const check = useCallback(async () => {
    if (!navigator.onLine) {
      setState('offline');
      setDetail('No hay internet. La app conserva los cambios localmente y los sincroniza al reconectar.');
      return;
    }

    setState('checking');
    const result = await checkSupabaseHealth();
    setState(result.connected ? 'connected' : 'error');
    setDetail(result.detail || (result.connected ? 'La API y la tabla de trabajadores respondieron correctamente.' : 'Supabase no respondió correctamente.'));
    setCheckedAt(Date.now());
  }, []);

  useEffect(() => {
    void check();
    const interval = window.setInterval(() => void check(), 20_000);
    const onOnline = () => void check();
    const onOffline = () => {
      setState('offline');
      setDetail('No hay internet. La app conserva los cambios localmente y los sincroniza al reconectar.');
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [check]);

  const Icon = state === 'connected' ? CheckCircle2
    : state === 'offline' ? WifiOff
      : state === 'error' ? AlertCircle
        : LoaderCircle;
  const status = state === 'connected' ? 'Conectado a Supabase'
    : state === 'offline' ? 'Sin internet · modo local'
      : state === 'error' ? 'No se pudo conectar'
        : 'Verificando conexión…';
  const tone = state === 'connected' ? '#08734e'
    : state === 'offline' ? '#9a5700'
      : state === 'error' ? '#a12d25'
        : '#53627a';
  const background = state === 'connected' ? '#e5f7ef'
    : state === 'offline' ? '#fff2dd'
      : state === 'error' ? '#fff0ee'
        : '#eef3fa';

  return <section id="conexion-supabase" className="panel" aria-live="polite" style={{ padding: 26 }}>
    <div className="row between" style={{ alignItems: 'flex-start', marginBottom: 22 }}>
      <div>
        <div className="eyebrow">ESTADO DEL SERVICIO</div>
        <h2 style={{ fontSize: 22 }}>Conexión a Supabase</h2>
      </div>
      <span style={{ width: 42, height: 42, display: 'grid', placeItems: 'center', borderRadius: 13, background: '#edf4ff', color: '#1769e0' }}><Cloud size={21} /></span>
    </div>

    <div className="row" style={{ gap: 9, padding: '12px 14px', marginBottom: 15, borderRadius: 11, color: tone, background }}>
      <Icon size={18} className={state === 'checking' ? 'connection-spin' : ''} />
      <b style={{ fontSize: 14 }}>{status}</b>
    </div>

    <p style={{ minHeight: 62, margin: '0 0 18px', color: '#68758b', fontSize: 13, lineHeight: 1.6 }}>{detail || 'Comprobando la API y la tabla de trabajadores.'}</p>

    <div className="row between" style={{ gap: 12, flexWrap: 'wrap' }}>
      <span className="small muted">{checkedAt ? `Última comprobación: ${new Date(checkedAt).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}` : 'Comprobación automática cada 20 segundos'}</span>
      <button type="button" className="btn secondary" onClick={() => void check()} disabled={state === 'checking'}>
        {state === 'checking' ? <LoaderCircle size={15} className="connection-spin" /> : <RefreshCw size={15} />}
        Comprobar ahora
      </button>
    </div>
    <p className="small muted" style={{ lineHeight: 1.6, margin: '18px 0 0' }}>La prueba verifica que la app pueda consultar Supabase. Las lecturas sin conexión quedan guardadas en este dispositivo hasta que se sincronicen.</p>
  </section>;
}
