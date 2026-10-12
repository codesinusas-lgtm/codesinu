'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, ArrowRight, Check, Cloud, CloudOff, LayoutGrid, List, LogOut, RefreshCw, Search, Wifi, WifiOff,
} from 'lucide-react';
import { getSupabase, supabaseConfigured } from '@/lib/supabase/client';
import { fetchWorkerReadings } from '@/lib/supabase/data';
import { hasAdminAccess } from '@/lib/auth-roles';
import { localDB, saveLocalReading, type Reading } from '@/lib/localdb';
import { syncPendingReadings } from '@/lib/sync';

type ViewMode = 'cards' | 'table' | 'individual';
type StatusFilter = 'all' | 'pending' | 'completed';

function isCompleted(reading: Reading) {
  return Boolean(reading.reading.trim() || reading.novelty.trim());
}

function readingSearchText(reading: Reading) {
  return [
    ...Object.values(reading.base), reading.sheetName, reading.rowNumber,
    reading.reading, reading.novelty, reading.observation,
  ].join(' ').toLocaleLowerCase('es');
}

export default function WorkerPage() {
  const [user, setUser] = useState<User | null>(null);
  const [offlineWorker, setOfflineWorker] = useState(false);
  const [workerUid, setWorkerUid] = useState('');
  const [workerName, setWorkerName] = useState('');
  const [authStatus, setAuthStatus] = useState<'checking' | 'allowed' | 'forbidden'>('checking');
  const [accountRole, setAccountRole] = useState('');
  const [readings, setReadings] = useState<Reading[]>([]);
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [loadingReadings, setLoadingReadings] = useState(true);
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');
  const [sheetFilter, setSheetFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('cards');
  const [individualIndex, setIndividualIndex] = useState(0);
  const autoSyncTimer = useRef<number | null>(null);
  const router = useRouter();

  useEffect(() => {
    if (!supabaseConfigured) {
      setAuthStatus('forbidden');
      return;
    }
    const supabase = getSupabase();
    const applyUser = (currentUser: User | null) => {
      if (!currentUser) {
        if (!navigator.onLine) {
          try {
            const savedWorker = JSON.parse(sessionStorage.getItem('sinucode-offline-worker') || 'null') as { uid?: string; name?: string } | null;
            if (savedWorker?.uid) {
              setWorkerUid(savedWorker.uid);
              setWorkerName(savedWorker.name || 'Trabajador');
              setUser(null);
              setOfflineWorker(true);
              setAuthStatus('allowed');
              return;
            }
          } catch { /* Ignore a damaged local offline session. */ }
        }
        setOfflineWorker(false);
        setAuthStatus('checking');
        router.replace('/login');
        return;
      }
      const role = typeof currentUser.app_metadata?.role === 'string' ? currentUser.app_metadata.role : '';
      setAccountRole(role);
      if (hasAdminAccess(currentUser.email, Boolean(currentUser.email_confirmed_at), role)) {
        router.replace('/admin');
      } else if (currentUser.is_anonymous) {
        const selectedUid = typeof currentUser.user_metadata?.worker_uid === 'string' ? currentUser.user_metadata.worker_uid : '';
        if (selectedUid) {
          setWorkerUid(selectedUid);
          setWorkerName(typeof currentUser.user_metadata?.worker_name === 'string' ? currentUser.user_metadata.worker_name : 'Trabajador');
          setUser(currentUser);
          setOfflineWorker(false);
          setAuthStatus('allowed');
        } else {
          setUser(null);
          setAuthStatus('forbidden');
        }
      } else {
        setUser(null);
        setAuthStatus('forbidden');
      }
    };
    void supabase.auth.getSession().then(({ data, error }) => {
      if (error) applyUser(null);
      else applyUser(data.session?.user || null);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => applyUser(session?.user || null));
    return () => subscription.unsubscribe();
  }, [router]);

  useEffect(() => {
    if (!offlineWorker || !workerUid) return;
    const resumeOnlineSession = () => {
      if (!navigator.onLine) return;
      void getSupabase().auth.signInAnonymously({
        options: { data: { worker_uid: workerUid, worker_name: workerName } },
      }).then(({ data, error }) => {
        if (error) throw error;
        sessionStorage.removeItem('sinucode-offline-worker');
        setOfflineWorker(false);
        setUser(data.user);
        setMessage('Sesión recuperada. Se sincronizarán las lecturas pendientes.');
      }).catch(error => {
        console.warn('Could not restore Supabase worker session after reconnecting', error);
        setMessage('Volvió internet, pero no se pudo abrir Supabase. Las lecturas siguen guardadas en este dispositivo.');
      });
    };
    window.addEventListener('online', resumeOnlineSession);
    return () => window.removeEventListener('online', resumeOnlineSession);
  }, [offlineWorker, workerUid, workerName]);

  const refreshLocal = useCallback(async (uid: string) => {
    const localRows = await localDB.readings.where('workerUid').equals(uid).toArray();
    localRows.sort((a, b) => a.sheetName.localeCompare(b.sheetName, 'es') || a.rowNumber - b.rowNumber);
    setReadings(localRows);
  }, []);

  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine);
    updateOnline();
    window.addEventListener('online', updateOnline);
    window.addEventListener('offline', updateOnline);
    return () => {
      window.removeEventListener('online', updateOnline);
      window.removeEventListener('offline', updateOnline);
    };
  }, []);

  useEffect(() => {
    if (!workerUid) return;
    let active = true;
    setLoadingReadings(true);
    void refreshLocal(workerUid)
      .catch(() => setMessage('No se pudo leer la copia local de este dispositivo.'))
      .finally(() => { if (active) setLoadingReadings(false); });
    return () => { active = false; };
  }, [workerUid, refreshLocal]);

  useEffect(() => {
    if (!user || !workerUid || !supabaseConfigured) return;
    let active = true;
    const supabase = getSupabase();
    const refreshRemote = () => {
      void (async () => {
        const incoming = await fetchWorkerReadings(workerUid);
        for (const remoteReading of incoming) {
          const localReading = await localDB.readings.get(remoteReading.id);
          if (!localReading || localReading.synced || remoteReading.updatedAt >= localReading.updatedAt) {
            await localDB.readings.put(remoteReading);
          }
        }
        await refreshLocal(workerUid);
      })().catch(error => {
        console.error('Could not load assigned readings from Supabase', error);
        setMessage(`No se pudieron cargar las lecturas desde Supabase (${error.code || error.message}).`);
      }).finally(() => {
        if (active) setLoadingReadings(false);
      });
    };
    void refreshRemote();
    const channel = supabase.channel(`worker-readings:${user.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'readings', filter: `worker_uid=eq.${workerUid}` }, refreshRemote)
      .subscribe();
    return () => { active = false; void supabase.removeChannel(channel); };
  }, [user, workerUid, refreshLocal]);

  useEffect(() => {
    if (!user || !workerUid) return;
    const autoSync = () => {
      if (!navigator.onLine) return;
      void syncPendingReadings(workerUid)
        .then(() => refreshLocal(workerUid))
        .catch(error => {
          console.error('Automatic reading sync failed', error);
          setMessage('No se pudo sincronizar automáticamente. Tus cambios siguen guardados en este dispositivo.');
        });
    };
    window.addEventListener('online', autoSync);
    autoSync();
    return () => window.removeEventListener('online', autoSync);
  }, [user, workerUid, refreshLocal]);

  useEffect(() => () => {
    if (autoSyncTimer.current !== null) window.clearTimeout(autoSyncTimer.current);
  }, []);

  useEffect(() => {
    if (!user || !supabaseConfigured) return;
    const supabase = getSupabase();
    const updatePresence = () => supabase.from('presence').upsert({
      uid: user.id,
      email: user.email || '',
      online: navigator.onLine,
      last_seen: Date.now(),
    }).then(({ error }) => { if (error) console.warn('Presence update failed', error); });
    updatePresence();
    const timer = window.setInterval(updatePresence, 30_000);
    window.addEventListener('online', updatePresence);
    window.addEventListener('offline', updatePresence);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', updatePresence);
      window.removeEventListener('offline', updatePresence);
      void supabase.from('presence').upsert({ uid: user.id, online: false, last_seen: Date.now() }).then(() => {});
    };
  }, [user]);

  const sheets = useMemo(
    () => [...new Set(readings.map(reading => reading.sheetName))].sort((a, b) => a.localeCompare(b, 'es')),
    [readings],
  );
  const filteredReadings = useMemo(() => readings.filter(reading => {
    if (sheetFilter !== 'all' && reading.sheetName !== sheetFilter) return false;
    if (statusFilter === 'pending' && isCompleted(reading)) return false;
    if (statusFilter === 'completed' && !isCompleted(reading)) return false;
    return readingSearchText(reading).includes(search.trim().toLocaleLowerCase('es'));
  }), [readings, search, sheetFilter, statusFilter]);
  useEffect(() => {
    setIndividualIndex(index => Math.min(index, Math.max(0, filteredReadings.length - 1)));
  }, [filteredReadings.length]);
  const individualReading = filteredReadings[individualIndex];
  const completedCount = readings.filter(isCompleted).length;
  const pendingSyncCount = readings.filter(reading => !reading.synced).length;

  async function edit(reading: Reading, field: 'reading' | 'observation' | 'novelty', value: string) {
    const updated = {
      ...reading,
      [field]: value,
      updatedAt: Date.now(),
      synced: false,
      version: reading.version,
    };
    await saveLocalReading(updated);
    const savedReading = await localDB.readings.get(reading.id) || { ...updated, version: reading.version + 1 };
    setReadings(current => current.map(item => item.id === reading.id ? savedReading : item));
    if (autoSyncTimer.current !== null) window.clearTimeout(autoSyncTimer.current);
    if (navigator.onLine && workerUid) {
      autoSyncTimer.current = window.setTimeout(() => {
        autoSyncTimer.current = null;
        setSyncing(true);
        void syncPendingReadings(workerUid)
          .then(() => refreshLocal(workerUid))
          .catch(error => {
            console.error('Automatic edit sync failed', error);
            setMessage('El cambio quedó guardado en este dispositivo, pero Supabase no lo aceptó. Revisa las políticas RLS o vuelve a sincronizar.');
          })
          .finally(() => setSyncing(false));
      }, 700);
    }
  }

  async function sync() {
    if (!user || !workerUid) return;
    if (!navigator.onLine) {
      setMessage('Sin conexión. Las lecturas editadas siguen guardadas localmente y se sincronizarán al volver a tener internet.');
      return;
    }
    if (autoSyncTimer.current !== null) {
      window.clearTimeout(autoSyncTimer.current);
      autoSyncTimer.current = null;
    }
    setSyncing(true);
    try {
      const result = await syncPendingReadings(workerUid);
      await refreshLocal(workerUid);
      setMessage(`Sincronización completada: ${result.synced} lecturas enviadas.`);
    } catch (error) {
      console.error('Reading sync failed', error);
      setMessage('Supabase rechazó la sincronización. Verifica las políticas RLS y que las lecturas sigan asignadas a tu usuario. Tus cambios permanecen en este dispositivo.');
    } finally {
      setSyncing(false);
    }
  }

  async function exit() {
    if (autoSyncTimer.current !== null) {
      window.clearTimeout(autoSyncTimer.current);
      autoSyncTimer.current = null;
    }
    if (workerUid && navigator.onLine) {
      try { await syncPendingReadings(workerUid); } catch (error) { console.error('Final worker sync failed', error); }
    }
    sessionStorage.removeItem('sinucode-offline-worker');
    sessionStorage.removeItem('sinucode-worker-uid');
    sessionStorage.removeItem('sinucode-worker-name');
    if (navigator.onLine && supabaseConfigured) await getSupabase().auth.signOut();
    router.replace('/login');
  }

  if (authStatus !== 'allowed') {
    return <main className="worker-layout" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 20 }}>
      <section className="panel" style={{ width: '100%', maxWidth: 520, padding: 30 }}>
        <div className="brand" style={{ color: '#14213a', marginBottom: 20 }}><span className="brand-mark">S</span> sinucode</div>
        <h1 style={{ fontSize: 23, marginBottom: 10 }}>{authStatus === 'checking' ? 'Verificando acceso…' : 'No tienes acceso de trabajador'}</h1>
        <p className="muted" style={{ lineHeight: 1.6 }}>{authStatus === 'checking'
          ? 'Estamos validando tu sesión.'
          : accountRole
            ? `Tu cuenta tiene el rol “${accountRole}”. Ingresa desde el espacio correspondiente.`
            : 'Vuelve al inicio e ingresa seleccionando tu nombre en la lista de trabajadores.'}</p>
        {authStatus === 'forbidden' && <button className="btn secondary" style={{ marginTop: 12 }} onClick={exit}><LogOut size={16} /> Cerrar sesión</button>}
      </section>
    </main>;
  }

  return <main className="worker-layout" style={{ padding: '22px 16px 60px' }}>
    <header className="topbar">
      <div>
        <div className="brand" style={{ color: '#14213a', marginBottom: 18 }}><span className="brand-mark">S</span> sinucode</div>
        <div className="eyebrow">ESPACIO DE TRABAJO / CAMPO</div>
        <h1 className="page-title">Mis lecturas</h1>
        <p className="muted" style={{ fontSize: 13, marginTop: 7 }}>{workerName} · Cada cambio se guarda primero en este dispositivo y luego se sincroniza con Supabase cuando hay conexión.</p>
      </div>
      <div className="row">
        <span className={`pill ${online ? 'green' : 'orange'}`}>{online ? <><Wifi size={13} /> En línea</> : <><WifiOff size={13} /> Sin conexión</>}</span>
        <button className="btn secondary" onClick={exit} title="Cerrar sesión"><LogOut size={16} /></button>
      </div>
    </header>

    {!supabaseConfigured && <div className="notice warn" style={{ marginBottom: 18 }}>Supabase no está configurado. Solo podrás ver las lecturas guardadas previamente en este dispositivo.</div>}
    {!online && <div className="notice warn" role="status" style={{ marginBottom: 18 }}>{offlineWorker ? 'Sesión local sin internet.' : 'Sin conexión a internet.'} Puedes consultar y editar las lecturas descargadas; se enviarán a Supabase cuando vuelva la conexión.</div>}
    {message && <div className="notice" role="status" style={{ marginBottom: 18 }}>{message}</div>}

    <div className="cards" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))' }}>
      <div className="card"><div className="stat-label">Asignadas</div><div className="stat-value">{readings.length}</div></div>
      <div className="card"><div className="stat-label">Diligenciadas</div><div className="stat-value">{completedCount}</div><div className="progress"><span style={{ width: `${readings.length ? completedCount / readings.length * 100 : 0}%` }} /></div></div>
      <div className="card"><div className="stat-label">Pendientes de subir a la nube</div><div className="stat-value">{pendingSyncCount}</div><div className="stat-foot">Copias locales aún no confirmadas por Supabase</div></div>
    </div>

    <section className="panel" style={{ margin: '18px 0', padding: 16 }}>
      <div className="form-grid" style={{ gridTemplateColumns: 'minmax(220px,2fr) minmax(160px,1fr) minmax(160px,1fr) auto', alignItems: 'end' }}>
        <label className="field">Buscar por cualquier dato
          <div style={{ position: 'relative' }}><Search size={16} style={{ position: 'absolute', left: 12, top: 13, color: '#68758b' }} /><input className="input" style={{ paddingLeft: 36 }} value={search} onChange={event => setSearch(event.target.value)} placeholder="Nombre, contrato, dirección, medidor…" /></div>
        </label>
        <label className="field">Hoja
          <select className="input" value={sheetFilter} onChange={event => setSheetFilter(event.target.value)}>
            <option value="all">Todas las hojas</option>
            {sheets.map(sheet => <option key={sheet} value={sheet}>{sheet}</option>)}
          </select>
        </label>
        <label className="field">Estado
          <select className="input" value={statusFilter} onChange={event => setStatusFilter(event.target.value as StatusFilter)}>
            <option value="all">Todas</option><option value="pending">Pendientes</option><option value="completed">Diligenciadas</option>
          </select>
        </label>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <button type="button" className={`btn ${viewMode === 'cards' ? '' : 'secondary'}`} title="Vista de tarjetas" aria-pressed={viewMode === 'cards'} onClick={() => setViewMode('cards')}><LayoutGrid size={16} /></button>
          <button type="button" className={`btn ${viewMode === 'table' ? '' : 'secondary'}`} title="Vista de tabla" aria-pressed={viewMode === 'table'} onClick={() => setViewMode('table')}><List size={16} /></button>
          <button type="button" className={`btn ${viewMode === 'individual' ? '' : 'secondary'}`} title="Vista de medición individual" aria-pressed={viewMode === 'individual'} onClick={() => setViewMode('individual')}><Search size={16} /></button>
          <button type="button" className="btn secondary" onClick={() => workerUid && refreshLocal(workerUid)} title="Actualizar copia local"><RefreshCw size={16} /></button>
        </div>
      </div>
      <div className="row between" style={{ marginTop: 14, flexWrap: 'wrap' }}>
        <span className="small muted">Mostrando {filteredReadings.length} de {readings.length} lecturas. Puedes editar desde cualquiera de las vistas.</span>
        <button className="btn" onClick={sync} disabled={syncing || pendingSyncCount === 0}><RefreshCw size={16} />{syncing ? 'Sincronizando…' : `Sincronizar (${pendingSyncCount})`}</button>
      </div>
    </section>

    {filteredReadings.length > 0 && viewMode === 'cards' && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,360px),1fr))', gap: 14 }}>
      {filteredReadings.map(reading => <article className="reading-card" key={reading.id}>
        <div className="row between" style={{ alignItems: 'flex-start', marginBottom: 14 }}>
          <div>
            <div className="small muted" style={{ marginBottom: 5 }}>{reading.sheetName} · Fila {reading.rowNumber} · Contrato {String(reading.base.CONTRATO ?? '—')}</div>
            <h2 style={{ fontSize: 17, marginBottom: 5 }}>{String(reading.base.NOMBRE ?? 'Sin nombre')}</h2>
            <div className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>{String(reading.base.DIRECCION ?? '')}</div>
            <div className="small muted" style={{ marginTop: 5 }}>Medidor: {String(reading.base.MEDIDOR ?? '—')} · Ruta: {String(reading.base.RUTA ?? '—')}</div>
          </div>
          <span className={`pill ${reading.synced ? 'green' : 'orange'}`}>{reading.synced ? 'En Supabase' : 'Pendiente de nube'}</span>
        </div>
        <div className="form-grid">
          <label className="field">Lectura actual<input className="input" inputMode="decimal" value={reading.reading} onChange={event => void edit(reading, 'reading', event.target.value)} placeholder="Escribe la lectura" /></label>
          <label className="field">Motivo de novedad<select className="input" value={reading.novelty} onChange={event => void edit(reading, 'novelty', event.target.value)}><option value="">Sin novedad</option><option>Inmueble cerrado</option><option>Medidor dañado</option><option>Medidor ilegible</option><option>Predio desocupado</option><option>Acceso impedido</option><option>Medidor retirado</option><option>Otro</option></select></label>
          <label className="field" style={{ gridColumn: '1/-1' }}>Observación<textarea className="input" rows={2} value={reading.observation} onChange={event => void edit(reading, 'observation', event.target.value)} placeholder="Detalle adicional (opcional)" /></label>
        </div>
        <div className="row between" style={{ marginTop: 12 }}><span className="small muted">Guardado automáticamente en este dispositivo</span><span className="row small" style={{ color: '#138a60' }}><Check size={14} /> Copia local segura</span></div>
      </article>)}
    </div>}

    {filteredReadings.length > 0 && viewMode === 'table' && <div className="table-wrap">
      <table>
        <thead><tr><th>Hoja / fila</th><th>Consecutivo</th><th>Contrato</th><th>Nombre</th><th>Dirección</th><th>Medidor</th><th>Ruta</th><th>Lectura</th><th>Novedad</th><th>Observación</th><th>Estado</th></tr></thead>
        <tbody>{filteredReadings.map(reading => <tr key={reading.id}>
          <td>{reading.sheetName}<br /><span className="small muted">Fila {reading.rowNumber}</span></td>
          <td>{String(reading.base.CONSEC ?? reading.base.CONSECUTIVO ?? '—')}</td>
          <td>{String(reading.base.CONTRATO ?? '—')}</td>
          <td>{String(reading.base.NOMBRE ?? 'Sin nombre')}</td>
          <td>{String(reading.base.DIRECCION ?? '—')}</td>
          <td>{String(reading.base.MEDIDOR ?? '—')}</td>
          <td>{String(reading.base.RUTA ?? '—')}</td>
          <td><input aria-label={`Lectura de contrato ${String(reading.base.CONTRATO ?? '')}`} className="input" style={{ minWidth: 110 }} inputMode="decimal" value={reading.reading} onChange={event => void edit(reading, 'reading', event.target.value)} /></td>
          <td><select aria-label={`Novedad de contrato ${String(reading.base.CONTRATO ?? '')}`} className="input" style={{ minWidth: 150 }} value={reading.novelty} onChange={event => void edit(reading, 'novelty', event.target.value)}><option value="">Sin novedad</option><option>Inmueble cerrado</option><option>Medidor dañado</option><option>Medidor ilegible</option><option>Predio desocupado</option><option>Acceso impedido</option><option>Medidor retirado</option><option>Otro</option></select></td>
          <td><input aria-label={`Observación de contrato ${String(reading.base.CONTRATO ?? '')}`} className="input" style={{ minWidth: 180 }} value={reading.observation} onChange={event => void edit(reading, 'observation', event.target.value)} /></td>
          <td><span className={`pill ${reading.synced ? 'green' : 'orange'}`}>{reading.synced ? 'En Supabase' : 'Pendiente de nube'}</span></td>
        </tr>)}</tbody>
      </table>
    </div>}

    {filteredReadings.length > 0 && viewMode === 'individual' && individualReading && <section className="panel" aria-label="Medición individual" style={{ marginTop: 16, padding: 'clamp(18px,4vw,32px)' }}>
      <div className="row between" style={{ gap: 12, flexWrap: 'wrap', paddingBottom: 18, borderBottom: '1px solid #e7ebf1' }}>
        <div>
          <div className="eyebrow">MEDICIÓN INDIVIDUAL</div>
          <h2 style={{ fontSize: 18, margin: '6px 0' }}>Registro {individualIndex + 1} de {filteredReadings.length}</h2>
          <div className="small muted">{individualReading.sheetName} · Fila {individualReading.rowNumber}</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn secondary" type="button" disabled={individualIndex === 0} onClick={() => setIndividualIndex(index => Math.max(0, index - 1))}><ArrowLeft size={16} /> Anterior</button>
          <button className="btn secondary" type="button" disabled={individualIndex >= filteredReadings.length - 1} onClick={() => setIndividualIndex(index => Math.min(filteredReadings.length - 1, index + 1))}>Siguiente <ArrowRight size={16} /></button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,210px),1fr))', gap: 12, padding: '20px 0' }}>
        {[
          ['Contrato', individualReading.base.CONTRATO],
          ['Nombre', individualReading.base.NOMBRE],
          ['Dirección', individualReading.base.DIRECCION],
          ['Medidor', individualReading.base.MEDIDOR],
          ['Ruta', individualReading.base.RUTA],
          ['Consecutivo', individualReading.base.CONSEC ?? individualReading.base.CONSECUTIVO],
        ].map(([label, value]) => <div key={String(label)} style={{ background: '#f7f9fc', borderRadius: 10, padding: '12px 14px', minWidth: 0 }}>
          <div className="small muted" style={{ marginBottom: 5 }}>{label}</div>
          <div style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{String(value ?? '—')}</div>
        </div>)}
      </div>

      <div className="form-grid" style={{ borderTop: '1px solid #e7ebf1', paddingTop: 20 }}>
        <label className="field">Lectura actual<input autoFocus className="input" inputMode="decimal" value={individualReading.reading} onChange={event => void edit(individualReading, 'reading', event.target.value)} placeholder="Escribe la lectura" /></label>
        <label className="field">Motivo de novedad<select className="input" value={individualReading.novelty} onChange={event => void edit(individualReading, 'novelty', event.target.value)}><option value="">Sin novedad</option><option>Inmueble cerrado</option><option>Medidor dañado</option><option>Medidor ilegible</option><option>Predio desocupado</option><option>Acceso impedido</option><option>Medidor retirado</option><option>Otro</option></select></label>
        <label className="field" style={{ gridColumn: '1/-1' }}>Observación<textarea className="input" rows={3} value={individualReading.observation} onChange={event => void edit(individualReading, 'observation', event.target.value)} placeholder="Detalle adicional (opcional)" /></label>
      </div>
      <div className="row between" style={{ marginTop: 16, flexWrap: 'wrap' }}>
        <span className={`pill ${individualReading.synced ? 'green' : 'orange'}`}>{individualReading.synced ? 'Confirmada en Supabase' : 'Solo en este dispositivo'}</span>
        <span className="small muted">Puedes avanzar al siguiente registro mientras se sincronizan los cambios.</span>
      </div>
    </section>}

    {!filteredReadings.length && <div className="panel" style={{ textAlign: 'center', padding: 40, marginTop: 16 }}>
      <div className="stat-icon" style={{ margin: '0 auto 15px' }}>{online ? <Cloud size={22} /> : <CloudOff size={22} />}</div>
      <h2 style={{ fontSize: 18, marginBottom: 8 }}>{loadingReadings ? 'Cargando lecturas…' : readings.length ? 'No hay resultados con estos filtros' : 'Aún no hay lecturas asignadas'}</h2>
      <p className="muted" style={{ fontSize: 13, lineHeight: 1.6 }}>{readings.length
        ? 'Prueba otra búsqueda, cambia el estado o selecciona todas las hojas.'
        : `El administrador debe asignar una hoja o rango al trabajador ${workerName}. Al asignarla, aparecerá aquí desde Supabase y quedará disponible en la copia local.`}</p>
      {readings.length > 0 && <button className="btn secondary" style={{ marginTop: 12 }} onClick={() => { setSearch(''); setSheetFilter('all'); setStatusFilter('all'); }}>Limpiar filtros</button>}
    </div>}
    <p className="small muted" style={{ textAlign: 'center', lineHeight: 1.6, marginTop: 25 }}>Los cambios se guardan en este dispositivo y se sincronizan con Supabase cuando hay conexión.</p>
  </main>;
}
