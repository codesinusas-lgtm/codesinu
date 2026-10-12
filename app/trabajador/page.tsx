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
  const [drafts, setDrafts] = useState<Record<string, Partial<Pick<Reading, 'reading' | 'novelty' | 'observation'>>>>({});
  const [savingIds, setSavingIds] = useState<string[]>([]);
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
        const remoteIds = new Set(incoming.map(reading => reading.id));
        const cachedAssigned = await localDB.readings.where('workerUid').equals(workerUid).toArray();
        const staleCachedIds = cachedAssigned
          .filter(reading => reading.synced && !remoteIds.has(reading.id))
          .map(reading => reading.id);
        if (staleCachedIds.length) await localDB.readings.bulkDelete(staleCachedIds);
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

  function edit(reading: Reading, field: 'reading' | 'observation' | 'novelty', value: string) {
    setDrafts(current => ({ ...current, [reading.id]: { ...(current[reading.id] || {}), [field]: value } }));
    setMessage('');
  }

  async function saveReading(reading: Reading) {
    const draft = drafts[reading.id];
    if (!draft || Object.keys(draft).length === 0 || savingIds.includes(reading.id)) return;
    setSavingIds(current => [...current, reading.id]);
    setMessage('');
    const updated: Reading = { ...reading, ...draft, updatedAt: Date.now(), synced: false, version: reading.version };
    try {
      await saveLocalReading(updated);
      const savedReading = await localDB.readings.get(reading.id) || { ...updated, version: reading.version + 1 };
      setReadings(current => current.map(item => item.id === reading.id ? savedReading : item));
      setDrafts(current => { const next = { ...current }; delete next[reading.id]; return next; });
      setMessage('Lectura guardada en este dispositivo.');
      if (navigator.onLine && workerUid && user) {
        setSyncing(true);
        try {
          const result = await syncPendingReadings(workerUid);
          await refreshLocal(workerUid);
          setMessage(`Lectura guardada y sincronización completada (${result.synced} lecturas enviadas).`);
        } catch (error) {
          console.error('Manual reading sync failed', error);
          setMessage('La lectura quedó guardada en este dispositivo, pero no se pudo sincronizar con Supabase. Puedes volver a sincronizar más tarde.');
        } finally { setSyncing(false); }
      } else {
        setMessage('Lectura guardada en este dispositivo. Queda pendiente de sincronización cuando haya conexión.');
      }
    } catch (error) {
      console.error('Could not save reading locally', error);
      setMessage('No se pudo guardar la lectura. Tus cambios siguen como borrador; inténtalo de nuevo.');
    } finally { setSavingIds(current => current.filter(id => id !== reading.id)); }
  }

  function getDraftValue(reading: Reading, field: 'reading' | 'novelty' | 'observation') {
    return drafts[reading.id]?.[field] ?? reading[field];
  }

  function hasDraft(reading: Reading) {
    return Boolean(drafts[reading.id] && Object.keys(drafts[reading.id]!).length);
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
    return (
      <main className="worker-layout" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '16px' }}>
        <section className="panel" style={{ width: '100%', maxWidth: 520, padding: '24px 20px', borderRadius: '16px' }}>
          <div className="brand" style={{ color: '#14213a', marginBottom: 16 }}><span className="brand-mark">S</span> sinucode</div>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: 10 }}>{authStatus === 'checking' ? 'Verificando acceso…' : 'No tienes acceso de trabajador'}</h1>
          <p className="muted" style={{ lineHeight: 1.5, fontSize: '0.95rem' }}>
            {authStatus === 'checking'
              ? 'Estamos validando tu sesión.'
              : accountRole
                ? `Tu cuenta tiene el rol “${accountRole}”. Ingresa desde el espacio correspondiente.`
                : 'Vuelve al inicio e ingresa seleccionando tu nombre en la lista de trabajadores.'}
          </p>
          {authStatus === 'forbidden' && (
            <button className="btn secondary" style={{ marginTop: 16, width: '100%', minHeight: '44px' }} onClick={exit}>
              <LogOut size={18} /> Cerrar sesión
            </button>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="worker-layout" style={{ padding: '12px 12px 80px', maxWidth: '1200px', margin: '0 auto' }}>
      <header className="topbar" style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
          <div className="brand" style={{ color: '#14213a', fontSize: '1.1rem' }}><span className="brand-mark">S</span> sinucode</div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <span className={`pill ${online ? 'green' : 'orange'}`} style={{ padding: '6px 10px', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '4px' }}>
              {online ? <><Wifi size={14} /> En línea</> : <><WifiOff size={14} /> Sin conexión</>}
            </span>
            <button className="btn secondary" onClick={exit} title="Cerrar sesión" style={{ padding: '8px', minHeight: '38px', minWidth: '38px' }}>
              <LogOut size={18} />
            </button>
          </div>
        </div>

        <div>
          <div className="eyebrow" style={{ fontSize: '0.75rem', letterSpacing: '0.05em', color: '#64748b', fontWeight: 600 }}>ESPACIO DE TRABAJO / CAMPO</div>
          <h1 className="page-title" style={{ fontSize: '1.5rem', fontWeight: 700, margin: '2px 0' }}>Mis lecturas</h1>
          <p className="muted" style={{ fontSize: '0.85rem', lineHeight: 1.4, marginTop: 4 }}>
            <strong>{workerName}</strong> · Edita la lectura y pulsa “Guardar lectura” para guardar localmente; se sincronizan al tener conexión.
          </p>
        </div>
      </header>

      {!supabaseConfigured && <div className="notice warn" style={{ marginBottom: 14, borderRadius: '10px', fontSize: '0.875rem' }}>Supabase no está configurado. Solo podrás ver las lecturas guardadas previamente en este dispositivo.</div>}
      {!online && <div className="notice warn" role="status" style={{ marginBottom: 14, borderRadius: '10px', fontSize: '0.875rem' }}>{offlineWorker ? 'Sesión local sin internet.' : 'Sin conexión a internet.'} Puedes consultar y editar; se sincronizarán al volver la conexión.</div>}
      {message && <div className="notice" role="status" style={{ marginBottom: 14, borderRadius: '10px', fontSize: '0.875rem' }}>{message}</div>}

      <div className="cards" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '10px', marginBottom: '16px' }}>
        <div className="card" style={{ padding: '12px', borderRadius: '12px' }}>
          <div className="stat-label" style={{ fontSize: '0.75rem' }}>Asignadas</div>
          <div className="stat-value" style={{ fontSize: '1.4rem', fontWeight: 700 }}>{readings.length}</div>
        </div>
        <div className="card" style={{ padding: '12px', borderRadius: '12px' }}>
          <div className="stat-label" style={{ fontSize: '0.75rem' }}>Diligenciadas</div>
          <div className="stat-value" style={{ fontSize: '1.4rem', fontWeight: 700 }}>{completedCount}</div>
          <div className="progress" style={{ marginTop: '6px', height: '6px', borderRadius: '3px' }}>
            <span style={{ width: `${readings.length ? (completedCount / readings.length) * 100 : 0}%`, height: '100%', borderRadius: '3px' }} />
          </div>
        </div>
        <div className="card" style={{ padding: '12px', borderRadius: '12px', gridColumn: '1 / -1' }}>
          <div className="stat-label" style={{ fontSize: '0.75rem' }}>Pendientes de subir a la nube</div>
          <div className="stat-value" style={{ fontSize: '1.4rem', fontWeight: 700, color: pendingSyncCount > 0 ? '#d97706' : 'inherit' }}>{pendingSyncCount}</div>
          <div className="stat-foot" style={{ fontSize: '0.75rem', marginTop: '2px' }}>Copias locales aún no confirmadas por Supabase</div>
        </div>
      </div>

      <section className="panel" style={{ marginBottom: '16px', padding: '14px', borderRadius: '14px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <label className="field" style={{ margin: 0 }}>
            <span style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '4px', display: 'block' }}>Buscar lectura</span>
            <div style={{ position: 'relative' }}>
              <Search size={18} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#68758b' }} />
              <input
                className="input"
                style={{ paddingLeft: 40, minHeight: '44px', fontSize: '0.95rem', borderRadius: '10px', width: '100%' }}
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="Nombre, contrato, dirección, medidor…"
              />
            </div>
          </label>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <label className="field" style={{ margin: 0 }}>
              <span style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '4px', display: 'block' }}>Hoja</span>
              <select className="input" style={{ minHeight: '44px', fontSize: '0.9rem', borderRadius: '10px', width: '100%' }} value={sheetFilter} onChange={event => setSheetFilter(event.target.value)}>
                <option value="all">Todas las hojas</option>
                {sheets.map(sheet => <option key={sheet} value={sheet}>{sheet}</option>)}
              </select>
            </label>

            <label className="field" style={{ margin: 0 }}>
              <span style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '4px', display: 'block' }}>Estado</span>
              <select className="input" style={{ minHeight: '44px', fontSize: '0.9rem', borderRadius: '10px', width: '100%' }} value={statusFilter} onChange={event => setStatusFilter(event.target.value as StatusFilter)}>
                <option value="all">Todas</option>
                <option value="pending">Pendientes</option>
                <option value="completed">Diligenciadas</option>
              </select>
            </label>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="row" style={{ gap: '6px', flexWrap: 'nowrap' }}>
              <button type="button" className={`btn ${viewMode === 'cards' ? '' : 'secondary'}`} style={{ minHeight: '40px', padding: '0 12px' }} title="Vista de tarjetas" aria-pressed={viewMode === 'cards'} onClick={() => setViewMode('cards')}><LayoutGrid size={18} /></button>
              <button type="button" className={`btn ${viewMode === 'table' ? '' : 'secondary'}`} style={{ minHeight: '40px', padding: '0 12px' }} title="Vista de tabla" aria-pressed={viewMode === 'table'} onClick={() => setViewMode('table')}><List size={18} /></button>
              <button type="button" className={`btn ${viewMode === 'individual' ? '' : 'secondary'}`} style={{ minHeight: '40px', padding: '0 12px' }} title="Vista de medición individual" aria-pressed={viewMode === 'individual'} onClick={() => setViewMode('individual')}><Search size={18} /></button>
              <button type="button" className="btn secondary" style={{ minHeight: '40px', padding: '0 12px' }} onClick={() => workerUid && refreshLocal(workerUid)} title="Actualizar copia local"><RefreshCw size={18} /></button>
            </div>
          </div>
        </div>

        <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <span className="small muted" style={{ fontSize: '0.8rem' }}>Mostrando {filteredReadings.length} de {readings.length} lecturas.</span>
          <button className="btn" style={{ minHeight: '44px', width: '100%', justifyContent: 'center' }} onClick={sync} disabled={syncing || pendingSyncCount === 0}>
            <RefreshCw size={18} className={syncing ? 'spin' : ''} />
            {syncing ? 'Sincronizando…' : `Sincronizar (${pendingSyncCount})`}
          </button>
        </div>
      </section>

      {filteredReadings.length > 0 && viewMode === 'cards' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '14px' }}>
          {filteredReadings.map(reading => (
            <article className="reading-card" key={reading.id} style={{ background: '#ffffff', borderRadius: '14px', border: '1px solid #e2e8f0', padding: '16px', boxShadow: '0 2px 4px rgba(0,0,0,0.02)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px', gap: '8px' }}>
                <div>
                  <div className="small muted" style={{ fontSize: '0.75rem', fontWeight: 600, color: '#64748b' }}>
                    {reading.sheetName} · Fila {reading.rowNumber} · Contrato {String(reading.base.CONTRATO ?? '—')}
                  </div>
                  <h2 style={{ fontSize: '1.1rem', fontWeight: 700, margin: '4px 0 2px 0', color: '#0f172a' }}>{String(reading.base.NOMBRE ?? 'Sin nombre')}</h2>
                  <div className="muted" style={{ fontSize: '0.875rem', color: '#334155', lineHeight: 1.3 }}>{String(reading.base.DIRECCION ?? '')}</div>
                  <div className="small muted" style={{ marginTop: '6px', fontSize: '0.8rem', background: '#f8fafc', padding: '4px 8px', borderRadius: '6px', display: 'inline-block' }}>
                    Medidor: <strong>{String(reading.base.MEDIDOR ?? '—')}</strong> · Ruta: <strong>{String(reading.base.RUTA ?? '—')}</strong>
                  </div>
                </div>
                <span className={`pill ${reading.synced ? 'green' : 'orange'}`} style={{ fontSize: '0.7rem', whiteSpace: 'nowrap', padding: '4px 8px' }}>
                  {reading.synced ? 'En Supabase' : 'Pendiente'}
                </span>
              </div>

              <div className="form-grid" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <label className="field" style={{ margin: 0 }}>
                  <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#1e293b', marginBottom: '4px', display: 'block' }}>Lectura actual</span>
                  <input
                    className="input"
                    inputMode="decimal"
                    style={{ minHeight: '44px', fontSize: '1rem', borderRadius: '8px', padding: '8px 12px', border: '1px solid #cbd5e1' }}
                    value={getDraftValue(reading, 'reading')}
                    onChange={event => edit(reading, 'reading', event.target.value)}
                    placeholder="Escribe la lectura"
                  />
                </label>

                <label className="field" style={{ margin: 0 }}>
                  <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#1e293b', marginBottom: '4px', display: 'block' }}>Motivo de novedad</span>
                  <select
                    className="input"
                    style={{ minHeight: '44px', fontSize: '0.95rem', borderRadius: '8px', padding: '8px 12px', border: '1px solid #cbd5e1', width: '100%' }}
                    value={getDraftValue(reading, 'novelty')}
                    onChange={event => edit(reading, 'novelty', event.target.value)}
                  >
                    <option>Toma exitosa</option>
                    <option>Enterrado</option>
                    <option>Tapado con Concreto</option>
                    <option>Nublado</option>
                    <option>Dañado/Roto</option>
                    <option>Inundado</option>
                    <option>Sin Medidor</option>
                    <option>Interno</option>
                    <option>Invertido</option>
                    <option>Lectura Inferior</option>
                    <option>Servicio Suspendido</option>
                    <option>Tapa con Daño Menor</option>
                    <option>Perro Bravo</option>
                    <option>Fuga</option>
                    <option>Contrabando/Ilegal</option>
                    <option>No encontrado</option>
                    <option>Deshabitado</option>
                    <option>Medio Lado</option>
                    <option>Averiado</option>
                    <option>Medidor Nuevo</option>
                    <option>Lectura de un Medidor - Varios</option>
                    <option>No Existe</option>
                    <option>Tapa de Cajilla Suelta</option>
                    <option>Cajilla sin Tapa</option>
                    <option>Tapa de Cajilla Rota</option>
                    <option>Tapa de Concreto Pesada</option>
                    <option>Cajilla Cerrada sin llave</option>
                    <option>Obstaculo Accidental</option>
                    <option>Contrato de otra ruta</option>
                    <option>En construcción</option>
                    <option>Posible Manipulación</option>
                    <option>Sin Acceso Deshabitado</option>
                    <option>Casa en Ruinas</option>
                    <option>Reconexión Ilegal</option>
                    <option>Medidor Completo Vuelta 9999</option>
                    <option>Contador Parado</option>
                    <option>Cortado a Red con Medidor</option>
                    <option>Medidor de Pruebas</option>
                    <option>Cortado sin Medidor</option>
                    <option>Cajilla defectuosa con lectura</option>
                    <option>Cajilla defectuosa sin lectura</option>
                  </select>
                </label>

                <label className="field" style={{ margin: 0 }}>
                  <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#1e293b', marginBottom: '4px', display: 'block' }}>Observación</span>
                  <textarea
                    className="input"
                    rows={2}
                    style={{ minHeight: '60px', fontSize: '0.95rem', borderRadius: '8px', padding: '8px 12px', border: '1px solid #cbd5e1', width: '100%' }}
                    value={getDraftValue(reading, 'observation')}
                    onChange={event => edit(reading, 'observation', event.target.value)}
                    placeholder="Detalle adicional (opcional)"
                  />
                </label>
              </div>

              <div style={{ marginTop: '14px', paddingTop: '10px', borderTop: '1px solid #f1f5f9', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ fontSize: '0.8rem', color: '#64748b', textAlign: 'center' }}>
                  {hasDraft(reading) ? '⚠️ Cambios sin guardar' : reading.synced ? '✓ Sin cambios pendientes' : '⌛ Pendiente de sincronización'}
                </div>
                <button
                  type="button"
                  className="btn"
                  style={{ minHeight: '44px', width: '100%', justifyContent: 'center', fontSize: '0.95rem' }}
                  onClick={() => void saveReading(reading)}
                  disabled={!hasDraft(reading) || savingIds.includes(reading.id)}
                >
                  <Check size={18} /> {savingIds.includes(reading.id) ? 'Guardando…' : 'Guardar lectura'}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {filteredReadings.length > 0 && viewMode === 'table' && (
        <div className="table-wrap" style={{ overflowX: 'auto', borderRadius: '12px', border: '1px solid #e2e8f0', background: '#fff' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
            <thead>
              <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0', textAlign: 'left' }}>
                <th style={{ padding: '10px 12px' }}>Hoja / fila</th>
                <th style={{ padding: '10px 12px' }}>Consecutivo</th>
                <th style={{ padding: '10px 12px' }}>Contrato</th>
                <th style={{ padding: '10px 12px' }}>Nombre</th>
                <th style={{ padding: '10px 12px' }}>Dirección</th>
                <th style={{ padding: '10px 12px' }}>Medidor</th>
                <th style={{ padding: '10px 12px' }}>Ruta</th>
                <th style={{ padding: '10px 12px' }}>Lectura</th>
                <th style={{ padding: '10px 12px' }}>Novedad</th>
                <th style={{ padding: '10px 12px' }}>Observación</th>
                <th style={{ padding: '10px 12px' }}>Estado</th>
                <th style={{ padding: '10px 12px' }}>Acción</th>
              </tr>
            </thead>
            <tbody>
              {filteredReadings.map(reading => (
                <tr key={reading.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td style={{ padding: '10px 12px' }}>{reading.sheetName}<br /><span className="small muted">Fila {reading.rowNumber}</span></td>
                  <td style={{ padding: '10px 12px' }}>{String(reading.base.CONSEC ?? reading.base.CONSECUTIVO ?? '—')}</td>
                  <td style={{ padding: '10px 12px' }}>{String(reading.base.CONTRATO ?? '—')}</td>
                  <td style={{ padding: '10px 12px' }}>{String(reading.base.NOMBRE ?? 'Sin nombre')}</td>
                  <td style={{ padding: '10px 12px' }}>{String(reading.base.DIRECCION ?? '—')}</td>
                  <td style={{ padding: '10px 12px' }}>{String(reading.base.MEDIDOR ?? '—')}</td>
                  <td style={{ padding: '10px 12px' }}>{String(reading.base.RUTA ?? '—')}</td>
                  <td style={{ padding: '10px 12px' }}>
                    <input
                      aria-label={`Lectura de contrato ${String(reading.base.CONTRATO ?? '')}`}
                      className="input"
                      style={{ minWidth: 110, minHeight: '38px', fontSize: '0.9rem' }}
                      inputMode="decimal"
                      value={getDraftValue(reading, 'reading')}
                      onChange={event => edit(reading, 'reading', event.target.value)}
                    />
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <select
                      aria-label={`Novedad de contrato ${String(reading.base.CONTRATO ?? '')}`}
                      className="input"
                      style={{ minWidth: 150, minHeight: '38px', fontSize: '0.9rem' }}
                      value={getDraftValue(reading, 'novelty')}
                      onChange={event => edit(reading, 'novelty', event.target.value)}
                    >
                      <option>Toma exitosa</option>
                      <option>Enterrado</option>
                      <option>Tapado con Concreto</option>
                      <option>Nublado</option>
                      <option>Dañado/Roto</option>
                      <option>Inundado</option>
                      <option>Sin Medidor</option>
                      <option>Interno</option>
                      <option>Invertido</option>
                      <option>Lectura Inferior</option>
                      <option>Servicio Suspendido</option>
                      <option>Tapa con Daño Menor</option>
                      <option>Perro Bravo</option>
                      <option>Fuga</option>
                      <option>Contrabando/Ilegal</option>
                      <option>No encontrado</option>
                      <option>Deshabitado</option>
                      <option>Medio Lado</option>
                      <option>Averiado</option>
                      <option>Medidor Nuevo</option>
                      <option>Lectura de un Medidor - Varios</option>
                      <option>No Existe</option>
                      <option>Tapa de Cajilla Suelta</option>
                      <option>Cajilla sin Tapa</option>
                      <option>Tapa de Cajilla Rota</option>
                      <option>Tapa de Concreto Pesada</option>
                      <option>Cajilla Cerrada sin llave</option>
                      <option>Obstaculo Accidental</option>
                      <option>Contrato de otra ruta</option>
                      <option>En construcción</option>
                      <option>Posible Manipulación</option>
                      <option>Sin Acceso Deshabitado</option>
                      <option>Casa en Ruinas</option>
                      <option>Reconexión Ilegal</option>
                      <option>Medidor Completo Vuelta 9999</option>
                      <option>Contador Parado</option>
                      <option>Cortado a Red con Medidor</option>
                      <option>Medidor de Pruebas</option>
                      <option>Cortado sin Medidor</option>
                      <option>Cajilla defectuosa con lectura</option>
                      <option>Cajilla defectuosa sin lectura</option>
                    </select>
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <input
                      aria-label={`Observación de contrato ${String(reading.base.CONTRATO ?? '')}`}
                      className="input"
                      style={{ minWidth: 180, minHeight: '38px', fontSize: '0.9rem' }}
                      value={getDraftValue(reading, 'observation')}
                      onChange={event => edit(reading, 'observation', event.target.value)}
                    />
                  </td>
                  <td style={{ padding: '10px 12px' }}><span className={`pill ${reading.synced ? 'green' : 'orange'}`}>{reading.synced ? 'En Supabase' : 'Pendiente'}</span></td>
                  <td style={{ padding: '10px 12px' }}>
                    <button type="button" className="btn" style={{ minHeight: '38px', padding: '0 12px' }} onClick={() => void saveReading(reading)} disabled={!hasDraft(reading) || savingIds.includes(reading.id)}>
                      {savingIds.includes(reading.id) ? '…' : 'Guardar'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {filteredReadings.length > 0 && viewMode === 'individual' && individualReading && (
        <section className="panel" aria-label="Medición individual" style={{ marginTop: 12, padding: '16px', borderRadius: '14px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', paddingBottom: '14px', borderBottom: '1px solid #e7ebf1' }}>
            <div>
              <div className="eyebrow" style={{ fontSize: '0.75rem' }}>MEDICIÓN INDIVIDUAL</div>
              <h2 style={{ fontSize: '1.2rem', fontWeight: 700, margin: '2px 0' }}>Registro {individualIndex + 1} de {filteredReadings.length}</h2>
              <div className="small muted" style={{ fontSize: '0.8rem' }}>{individualReading.sheetName} · Fila {individualReading.rowNumber}</div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <button className="btn secondary" type="button" style={{ minHeight: '44px', justifyContent: 'center' }} disabled={individualIndex === 0} onClick={() => setIndividualIndex(index => Math.max(0, index - 1))}>
                <ArrowLeft size={18} /> Anterior
              </button>
              <button className="btn secondary" type="button" style={{ minHeight: '44px', justifyContent: 'center' }} disabled={individualIndex >= filteredReadings.length - 1} onClick={() => setIndividualIndex(index => Math.min(filteredReadings.length - 1, index + 1))}>
                Siguiente <ArrowRight size={18} />
              </button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '10px', padding: '14px 0' }}>
            {[
              ['Contrato', individualReading.base.CONTRATO],
              ['Nombre', individualReading.base.NOMBRE],
              ['Dirección', individualReading.base.DIRECCION],
              ['Medidor', individualReading.base.MEDIDOR],
              ['Ruta', individualReading.base.RUTA],
              ['Consecutivo', individualReading.base.CONSEC ?? individualReading.base.CONSECUTIVO],
            ].map(([label, value]) => (
              <div key={String(label)} style={{ background: '#f8fafc', borderRadius: '8px', padding: '10px', minWidth: 0, border: '1px solid #f1f5f9' }}>
                <div className="small muted" style={{ fontSize: '0.75rem', marginBottom: '2px' }}>{label}</div>
                <div style={{ fontWeight: 600, fontSize: '0.875rem', wordBreak: 'break-word' }}>{String(value ?? '—')}</div>
              </div>
            ))}
          </div>

          <div className="form-grid" style={{ borderTop: '1px solid #e7ebf1', paddingTop: '14px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <label className="field" style={{ margin: 0 }}>
              <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#1e293b', marginBottom: '4px', display: 'block' }}>Lectura actual</span>
              <input
                autoFocus
                className="input"
                inputMode="decimal"
                style={{ minHeight: '48px', fontSize: '1.1rem', borderRadius: '8px', padding: '8px 12px', border: '1px solid #cbd5e1' }}
                value={getDraftValue(individualReading, 'reading')}
                onChange={event => edit(individualReading, 'reading', event.target.value)}
                placeholder="Escribe la lectura"
              />
            </label>

            <label className="field" style={{ margin: 0 }}>
              <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#1e293b', marginBottom: '4px', display: 'block' }}>Motivo de novedad</span>
              <select
                className="input"
                style={{ minHeight: '44px', fontSize: '0.95rem', borderRadius: '8px', padding: '8px 12px', border: '1px solid #cbd5e1', width: '100%' }}
                value={getDraftValue(individualReading, 'novelty')}
                onChange={event => edit(individualReading, 'novelty', event.target.value)}
              >
                <option>Toma exitosa</option>
                <option>Enterrado</option>
                <option>Tapado con Concreto</option>
                <option>Nublado</option>
                <option>Dañado/Roto</option>
                <option>Inundado</option>
                <option>Sin Medidor</option>
                <option>Interno</option>
                <option>Invertido</option>
                <option>Lectura Inferior</option>
                <option>Servicio Suspendido</option>
                <option>Tapa con Daño Menor</option>
                <option>Perro Bravo</option>
                <option>Fuga</option>
                <option>Contrabando/Ilegal</option>
                <option>No encontrado</option>
                <option>Deshabitado</option>
                <option>Medio Lado</option>
                <option>Averiado</option>
                <option>Medidor Nuevo</option>
                <option>Lectura de un Medidor - Varios</option>
                <option>No Existe</option>
                <option>Tapa de Cajilla Suelta</option>
                <option>Cajilla sin Tapa</option>
                <option>Tapa de Cajilla Rota</option>
                <option>Tapa de Concreto Pesada</option>
                <option>Cajilla Cerrada sin llave</option>
                <option>Obstaculo Accidental</option>
                <option>Contrato de otra ruta</option>
                <option>En construcción</option>
                <option>Posible Manipulación</option>
                <option>Sin Acceso Deshabitado</option>
                <option>Casa en Ruinas</option>
                <option>Reconexión Ilegal</option>
                <option>Medidor Completo Vuelta 9999</option>
                <option>Contador Parado</option>
                <option>Cortado a Red con Medidor</option>
                <option>Medidor de Pruebas</option>
                <option>Cortado sin Medidor</option>
                <option>Cajilla defectuosa con lectura</option>
                <option>Cajilla defectuosa sin lectura</option>
              </select>
            </label>

            <label className="field" style={{ margin: 0 }}>
              <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#1e293b', marginBottom: '4px', display: 'block' }}>Observación</span>
              <textarea
                className="input"
                rows={3}
                style={{ minHeight: '70px', fontSize: '0.95rem', borderRadius: '8px', padding: '8px 12px', border: '1px solid #cbd5e1', width: '100%' }}
                value={getDraftValue(individualReading, 'observation')}
                onChange={event => edit(individualReading, 'observation', event.target.value)}
                placeholder="Detalle adicional (opcional)"
              />
            </label>
          </div>

          <div style={{ marginTop: '16px', paddingTop: '12px', borderTop: '1px solid #e7ebf1', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <span className={`pill ${hasDraft(individualReading) ? 'orange' : individualReading.synced ? 'green' : 'orange'}`} style={{ textAlign: 'center', fontSize: '0.8rem' }}>
              {hasDraft(individualReading) ? 'Cambios sin guardar' : individualReading.synced ? 'Confirmada en Supabase' : 'Pendiente de sincronización'}
            </span>
            <button
              type="button"
              className="btn"
              style={{ minHeight: '48px', width: '100%', justifyContent: 'center', fontSize: '1rem', fontWeight: 600 }}
              onClick={() => void saveReading(individualReading)}
              disabled={!hasDraft(individualReading) || savingIds.includes(individualReading.id)}
            >
              <Check size={18} /> {savingIds.includes(individualReading.id) ? 'Guardando…' : 'Guardar lectura'}
            </button>
          </div>
        </section>
      )}

      {!filteredReadings.length && (
        <div className="panel" style={{ textAlign: 'center', padding: '30px 16px', marginTop: 16, borderRadius: '14px' }}>
          <div className="stat-icon" style={{ margin: '0 auto 12px' }}>{online ? <Cloud size={24} /> : <CloudOff size={24} />}</div>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: 8 }}>{loadingReadings ? 'Cargando lecturas…' : readings.length ? 'No hay resultados con estos filtros' : 'Aún no hay lecturas asignadas'}</h2>
          <p className="muted" style={{ fontSize: '0.85rem', lineHeight: 1.5 }}>
            {readings.length
              ? 'Prueba otra búsqueda, cambia el estado o selecciona todas las hojas.'
              : `El administrador debe asignar una hoja o rango al trabajador ${workerName}. Al asignarla, aparecerá aquí.`}
          </p>
          {readings.length > 0 && (
            <button className="btn secondary" style={{ marginTop: 14, minHeight: '40px', width: '100%' }} onClick={() => { setSearch(''); setSheetFilter('all'); setStatusFilter('all'); }}>
              Limpiar filtros
            </button>
          )}
        </div>
      )}

      <p className="small muted" style={{ textAlign: 'center', lineHeight: 1.5, marginTop: 20, fontSize: '0.8rem' }}>
        Recuerda pulsar “Guardar lectura” después de terminar cada registro. Los cambios sin guardar se mantienen como borrador.
      </p>
    </main>
  );
}