'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { useRouter } from 'next/navigation';
import {
  ArrowDownToLine, BookOpen, CheckCircle2, CircleHelp, Cloud, FileSpreadsheet,
  Eye, LayoutDashboard, LogOut, Plus, RefreshCw, ShieldCheck, Upload, Users, Wifi, WifiOff,
} from 'lucide-react';
import { getSupabase, supabaseConfigured } from '@/lib/supabase/client';
import { fetchCycleReadings, readingToDb, readingFromDb } from '@/lib/supabase/data';
import { ADMIN_EMAIL, hasAdminAccess } from '@/lib/auth-roles';
import { exportWorkbook, parseWorkbook, type ImportedRow } from '@/lib/excel';
import { localDB, type CachedCycle, type Reading } from '@/lib/localdb';

type Worker = { uid: string; name: string; email: string; active?: boolean; role?: string };
type CycleRow = {
  id: string;
  name: string;
  status: string;
  importStatus?: 'importing' | 'active' | 'failed';
  sheetNames: string[];
  dataSheetNames?: string[];
  recordCount?: number;
  createdAt?: number;
  sourceFingerprint?: string;
};
type Presence = { uid: string; email?: string; online: boolean; lastSeen: number };
type ImportPreview = {
  id: string;
  name: string;
  fileName: string;
  bytes: ArrayBuffer;
  rows: ImportedRow[];
  sheetNames: string[];
  dataSheetNames: string[];
  skippedSheets: string[];
  fingerprint: string;
};

const BATCH_SIZE = 400;
const previewFields = ['NOMBRE', 'DIRECCION', 'RUTA', 'CONSEC', 'CONTRATO', 'MEDIDOR', 'LECTURA'];

function safeDocumentPart(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'ciclo';
}

async function fingerprintFile(bytes: ArrayBuffer) {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  // Fingerprinting only prevents accidental reimports; it is not used for authentication.
  const hashes = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  for (const byte of new Uint8Array(bytes)) {
    for (let index = 0; index < hashes.length; index++) {
      hashes[index] = Math.imul(hashes[index] ^ byte, 0x01000193 + index * 2) >>> 0;
    }
  }
  return hashes.map(hash => hash.toString(16).padStart(8, '0')).join('');
}

export default function AdminPage() {
  const [user, setUser] = useState<User | null>(null);
  const [authStatus, setAuthStatus] = useState<'checking' | 'allowed' | 'forbidden'>('checking');
  const [accountRole, setAccountRole] = useState('');
  const [cycles, setCycles] = useState<CycleRow[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [presence, setPresence] = useState<Presence[]>([]);
  const [readings, setReadings] = useState<Reading[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [cycleName, setCycleName] = useState('Ciclo octubre 2026');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [sourceTemplateFile, setSourceTemplateFile] = useState<File | null>(null);
  const [selectedCycle, setSelectedCycle] = useState('');
  const [workerUid, setWorkerUid] = useState('');
  const [sheetName, setSheetName] = useState('');
  const [mode, setMode] = useState<'sheet' | 'range'>('sheet');
  const [startRow, setStartRow] = useState('2');
  const [endRow, setEndRow] = useState('100');
  const [search, setSearch] = useState('');
  const [hasTemplate, setHasTemplate] = useState(false);
  const [newWorkerName, setNewWorkerName] = useState('');
  const [creatingWorker, setCreatingWorker] = useState(false);
  const [detailSheetFilter, setDetailSheetFilter] = useState('all');
  const [detailWorkerFilter, setDetailWorkerFilter] = useState('all');
  const [detailStatusFilter, setDetailStatusFilter] = useState<'all' | 'assigned' | 'unassigned' | 'completed' | 'pending'>('all');
  const router = useRouter();

  useEffect(() => {
    if (!supabaseConfigured) {
      setAuthStatus('forbidden');
      return;
    }
    const supabase = getSupabase();
    const applyUser = (currentUser: User | null) => {
      if (!currentUser) {
        setAuthStatus('checking');
        router.replace('/login');
        return;
      }
      const role = typeof currentUser.app_metadata?.role === 'string' ? currentUser.app_metadata.role : '';
      setAccountRole(role);
      if (hasAdminAccess(currentUser.email, Boolean(currentUser.email_confirmed_at), role)) {
        setUser(currentUser);
        setAuthStatus('allowed');
      } else if (currentUser.is_anonymous || currentUser.user_metadata?.worker_uid) {
        router.replace('/trabajador');
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
    if (!supabaseConfigured || !user) return;
    const supabase = getSupabase();
    const loadAdminData = async () => {
      if (!navigator.onLine) {
        const [cachedCycles, cachedWorkers] = await Promise.all([localDB.cycles.toArray(), localDB.workers.toArray()]);
        setCycles(cachedCycles);
        setWorkers(cachedWorkers.map(worker => ({ ...worker, email: '' })));
        setPresence([]);
        setMessage('Sin conexión. Mostrando el último estado guardado en este dispositivo; las acciones de administración requieren internet.');
        return;
      }
      const [cycleResult, workerResult, presenceResult] = await Promise.all([
        supabase.from('cycles').select('*').order('created_at', { ascending: false }),
        supabase.from('workers').select('*').order('name'),
        supabase.from('presence').select('*'),
      ]);
      const failed = cycleResult.error || workerResult.error || presenceResult.error;
      if (failed) {
        console.error('Supabase admin data load failed', failed);
        setMessage(`Supabase no pudo cargar el panel (${failed.code || failed.message}). Revisa las políticas RLS y la conexión.`);
        return;
      }
      const loadedCycles = (cycleResult.data || []).map(row => ({
        id: row.id, name: row.name, status: row.status, importStatus: row.import_status,
        sheetNames: row.sheet_names || [], dataSheetNames: row.data_sheet_names || [],
        recordCount: row.record_count || 0, createdAt: Number(row.created_at || 0),
        sourceFingerprint: row.source_fingerprint || '',
      } as CycleRow));
      setCycles(loadedCycles);
      await localDB.cycles.bulkPut(loadedCycles as CachedCycle[]);
      const loadedWorkers = (workerResult.data || []).map(row => ({
        uid: row.uid, name: row.name, email: row.email || '', role: row.role, active: row.active,
      } as Worker));
      setWorkers(loadedWorkers);
      await localDB.workers.bulkPut(loadedWorkers.map(worker => ({
        uid: worker.uid, name: worker.name, active: worker.active !== false,
      })));
      setPresence((presenceResult.data || []).map(row => ({
        uid: row.uid, email: row.email, online: row.online, lastSeen: Number(row.last_seen || 0),
      } as Presence)));
    };
    void loadAdminData();
    const channel = supabase.channel('admin-live-data')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cycles' }, () => void loadAdminData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'workers' }, () => void loadAdminData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'presence' }, () => void loadAdminData())
      .subscribe();
    window.addEventListener('online', loadAdminData);
    return () => {
      window.removeEventListener('online', loadAdminData);
      void supabase.removeChannel(channel);
    };
  }, [user]);

  const readyCycles = useMemo(
    () => cycles.filter(cycle => !cycle.importStatus || cycle.importStatus === 'active'),
    [cycles],
  );
  const activeCycle = readyCycles.find(cycle => cycle.id === selectedCycle) || readyCycles[0];
  const cycleId = activeCycle?.id || '';

  useEffect(() => {
    if (selectedCycle && !readyCycles.some(cycle => cycle.id === selectedCycle)) setSelectedCycle('');
  }, [readyCycles, selectedCycle]);

  useEffect(() => {
    if (!cycleId || !user || !supabaseConfigured) {
      setReadings([]);
      return;
    }
    let active = true;
    const supabase = getSupabase();
    const showCachedReadings = async () => {
      const rows = await localDB.readings.where('cycleId').equals(cycleId).toArray();
      rows.sort((a, b) => a.sheetName.localeCompare(b.sheetName, 'es') || a.rowNumber - b.rowNumber);
      if (active) setReadings(rows);
    };
    const refresh = () => {
      if (!navigator.onLine) {
        void showCachedReadings();
        return;
      }
      void fetchCycleReadings(cycleId)
        .then(async rows => {
          const merged = [] as Reading[];
          const toCache = [] as Reading[];
          for (const remote of rows) {
            const local = await localDB.readings.get(remote.id);
            const row = local && !local.synced && local.updatedAt > remote.updatedAt ? local : remote;
            merged.push(row);
            if (row === remote) toCache.push(remote);
          }
          await localDB.readings.bulkPut(toCache);
          if (active) setReadings(merged);
        })
        .catch(error => {
          console.error('Supabase cycle readings load failed', error);
          if (active) {
            void showCachedReadings();
            setMessage(`No se pudieron cargar las lecturas nuevas desde Supabase (${error.code || error.message}). Mostrando copia local.`);
          }
        });
    };
    void refresh();
    const channel = supabase.channel(`cycle-readings:${cycleId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'readings', filter: `cycle_id=eq.${cycleId}` }, refresh)
      .subscribe();
    window.addEventListener('online', refresh);
    return () => {
      active = false;
      window.removeEventListener('online', refresh);
      void supabase.removeChannel(channel);
    };
  }, [cycleId, user]);

  useEffect(() => {
    let mounted = true;
    setHasTemplate(false);
    if (cycleId) {
      localDB.templates.get(cycleId).then(template => {
        if (mounted) setHasTemplate(Boolean(template));
      }).catch(() => {
        if (mounted) setHasTemplate(false);
      });
    }
    return () => { mounted = false; };
  }, [cycleId]);

  const onlineWorkers = presence.filter(item => item.online && Date.now() - item.lastSeen < 90_000).length;
  const activeWorkers = workers.filter(worker => worker.active !== false);
  const completed = readings.filter(item => item.reading.trim() !== '' || item.novelty.trim() !== '').length;
  const pending = Math.max(0, readings.length - completed);
  const assignedCount = readings.filter(item => Boolean(item.workerUid)).length;
  const sheetOptions = [...new Set(readings.map(item => item.sheetName))].sort((a, b) => a.localeCompare(b, 'es'));
  const assignmentSummary = useMemo(() => {
    const summary = new Map<string, { workerUid: string; sheetName: string; total: number; completed: number }>();
    readings.forEach(reading => {
      if (!reading.workerUid) return;
      const key = `${reading.workerUid}::${reading.sheetName}`;
      const row = summary.get(key) || { workerUid: reading.workerUid, sheetName: reading.sheetName, total: 0, completed: 0 };
      row.total += 1;
      if (reading.reading.trim() || reading.novelty.trim()) row.completed += 1;
      summary.set(key, row);
    });
    return [...summary.values()].sort((a, b) => a.sheetName.localeCompare(b.sheetName, 'es'));
  }, [readings]);
  const filtered = useMemo(() => readings
    .filter(item => {
      const text = `${Object.values(item.base).join(' ')} ${item.sheetName} ${item.reading} ${item.novelty} ${item.observation}`.toLocaleLowerCase('es');
      if (!text.includes(search.trim().toLocaleLowerCase('es'))) return false;
      if (detailSheetFilter !== 'all' && item.sheetName !== detailSheetFilter) return false;
      if (detailWorkerFilter !== 'all' && (item.workerUid || 'unassigned') !== detailWorkerFilter) return false;
      if (detailStatusFilter === 'assigned' && !item.workerUid) return false;
      if (detailStatusFilter === 'unassigned' && item.workerUid) return false;
      if (detailStatusFilter === 'completed' && !(item.reading.trim() || item.novelty.trim())) return false;
      if (detailStatusFilter === 'pending' && (item.reading.trim() || item.novelty.trim())) return false;
      return true;
    })
    .slice(0, 100), [readings, search, detailSheetFilter, detailWorkerFilter, detailStatusFilter]);

  const readFileForPreview = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (!file || !supabaseConfigured || !user) {
      setMessage(!supabaseConfigured ? 'Configura Supabase antes de importar.' : 'Selecciona un archivo .xlsx.');
      return;
    }
    const name = cycleName.trim() || file.name.replace(/\.xlsx$/i, '');
    setBusy(true);
    setMessage('Leyendo el Excel y validando sus hojas…');
    try {
      const bytes = await file.arrayBuffer();
      const fingerprint = await fingerprintFile(bytes);
      const id = `cycle_${safeDocumentPart(name)}_${fingerprint.slice(0, 12)}`;
      const parsed = await parseWorkbook(file, id);
      setPreview({ id, name, fileName: file.name, bytes, ...parsed, fingerprint });
      const ignored = parsed.skippedSheets.length
        ? ` Se conservarán en el Excel original las hojas sin registros: ${parsed.skippedSheets.join(', ')}.`
        : '';
      if (!navigator.onLine) {
        setMessage(`Excel válido: ${parsed.rows.length.toLocaleString()} registros en ${parsed.dataSheetNames.length} hojas.${ignored} La vista previa queda disponible, pero necesitas conexión para verificar duplicados y guardar en Supabase.`);
        return;
      }
      try {
        const { data: existingCycle, error: queryError } = await getSupabase().from('cycles')
          .select('id,import_status').eq('id', id).maybeSingle();
        if (queryError) throw queryError;
        if (existingCycle && existingCycle.import_status !== 'failed') {
          setPreview(null);
          setMessage(`Este archivo ya se importó como “${name}”. Selecciona ese ciclo; no volveré a crear lecturas duplicadas.`);
          return;
        }
        setMessage(`Vista previa lista: ${parsed.rows.length.toLocaleString()} registros en ${parsed.dataSheetNames.length} hojas.${ignored}`);
      } catch (error) {
        console.error('Could not check existing cycle', error);
        const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
        setMessage(code.includes('42501') || code.includes('PGRST')
          ? `Excel leído correctamente (${parsed.rows.length.toLocaleString()} registros), pero Supabase rechazó la consulta. Revisa que aplicaste las políticas RLS del esquema.`
          : `Excel leído correctamente (${parsed.rows.length.toLocaleString()} registros), pero Supabase no responde${code ? ` (${code})` : ''}. La vista previa está disponible; revisa la conexión antes de guardar.`);
      }
    } catch (error) {
      setPreview(null);
      setMessage(error instanceof Error ? error.message : 'No se pudo leer el archivo Excel.');
    } finally {
      setBusy(false);
    }
  }, [file, supabaseConfigured, user, cycleName]);

  async function confirmImport() {
    if (!preview || !user) return;
    if (!navigator.onLine) {
      setMessage('Conéctate a internet antes de guardar el ciclo en Supabase. La vista previa sigue disponible.');
      return;
    }
    setBusy(true);
    setMessage(`Guardando ${preview.rows.length.toLocaleString()} registros en Supabase…`);
    const supabase = getSupabase();
    try {
      await localDB.templates.put({ cycleId: preview.id, name: preview.fileName, bytes: preview.bytes });
      const { error: cycleError } = await supabase.from('cycles').upsert({
        id: preview.id,
        name: preview.name,
        status: 'active',
        import_status: 'importing',
        sheet_names: preview.sheetNames,
        data_sheet_names: preview.dataSheetNames,
        source_file_name: preview.fileName,
        source_fingerprint: preview.fingerprint,
        record_count: preview.rows.length,
        created_at: Date.now(),
        created_by: user.id,
      });
      if (cycleError) throw cycleError;

      for (let offset = 0; offset < preview.rows.length; offset += BATCH_SIZE) {
        const batchRows = preview.rows.slice(offset, offset + BATCH_SIZE).map(row => readingToDb({
          ...row, workerUid: null, assignmentId: null, synced: true,
        }));
        const { error } = await supabase.from('readings').upsert(batchRows, { onConflict: 'id' });
        if (error) throw error;
        setMessage(`Guardados ${Math.min(offset + BATCH_SIZE, preview.rows.length).toLocaleString()} de ${preview.rows.length.toLocaleString()} registros…`);
      }

      const { error: finishError } = await supabase.from('cycles').update({ import_status: 'active', imported_at: Date.now() }).eq('id', preview.id);
      if (finishError) throw finishError;
      setSelectedCycle(preview.id);
      setFile(null);
      setPreview(null);
      setMessage(`Importación completada: ${preview.rows.length.toLocaleString()} registros en ${preview.dataSheetNames.length} hojas de Supabase. El archivo original sigue guardado solo en este navegador.`);
    } catch (error) {
      try { await supabase.from('cycles').update({ import_status: 'failed', import_error: 'La importación no terminó; no se puede asignar este ciclo.' }).eq('id', preview.id); } catch { /* Preserve the original failure. */ }
      console.error('Import failed', error);
      const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
      setMessage(code.includes('42501') || code.includes('PGRST')
        ? 'Supabase rechazó la importación. Revisa las políticas RLS y aplica el esquema SQL. El ciclo incompleto no se puede asignar.'
        : `La importación quedó incompleta${code ? ` (${code})` : ''}. No asignes este ciclo. Los registros parciales pueden permanecer en Supabase; corrige el error y vuelve a importar el mismo archivo para completar los documentos faltantes.`);
    } finally {
      setBusy(false);
    }
  }

  async function handleImportSubmit(event: React.FormEvent) {
    if (preview) {
      event.preventDefault();
      await confirmImport();
      return;
    }
    await readFileForPreview(event);
  }

  async function createWorker(event: React.FormEvent) {
    event.preventDefault();
    if (!navigator.onLine) {
      setMessage('Sin conexión. Puedes revisar los datos guardados, pero crear trabajadores requiere internet.');
      return;
    }
    const name = newWorkerName.trim().replace(/\s+/g, ' ');
    if (!name || !user) return;
    if (workers.some(worker => worker.name.trim().toLocaleLowerCase('es') === name.toLocaleLowerCase('es'))) {
      setMessage('Ya existe un trabajador con ese nombre. Busca el registro existente en la lista.');
      return;
    }
    setCreatingWorker(true);
    try {
      const uid = crypto.randomUUID();
      const { error } = await getSupabase().from('workers').insert({
        uid,
        name,
        email: '',
        role: 'worker',
        active: true,
        created_at: Date.now(),
        created_by: user.id,
      });
      if (error) throw error;
      setNewWorkerName('');
      setWorkerUid(uid);
      setMessage(`Trabajador creado: ${name}. Ya está disponible para asignaciones y para ingresar desde la lista.`);
    } catch (error) {
      console.error('Worker creation failed', error);
      const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
      setMessage(`No se pudo crear el trabajador en Supabase${code ? ` (${code})` : ''}. Comprueba que las políticas RLS estén aplicadas.`);
    } finally {
      setCreatingWorker(false);
    }
  }

  async function setWorkerActive(worker: Worker, active: boolean) {
    if (!navigator.onLine) {
      setMessage('Sin conexión. No se pudo cambiar el estado del trabajador.');
      return;
    }
    try {
      const { error } = await getSupabase().from('workers').update({ active }).eq('uid', worker.uid);
      if (error) throw error;
      setMessage(`${worker.name || worker.email} ${active ? 'activado' : 'desactivado'}.`);
    } catch (error) {
      console.error('Worker status update failed', error);
      setMessage('No se pudo actualizar el estado del trabajador en Supabase. Verifica las políticas RLS.');
    }
  }

  async function assign(event: React.FormEvent) {
    event.preventDefault();
    if (!navigator.onLine) {
      setMessage('Conéctate a internet antes de asignar hojas para confirmar el cambio en Supabase.');
      return;
    }
    if (!activeCycle || activeCycle.importStatus === 'importing' || !workerUid || !sheetName || !user) {
      setMessage('Selecciona un ciclo importado, trabajador y hoja.');
      return;
    }
    const firstRow = Number(startRow);
    const lastRow = Number(endRow);
    if (mode === 'range' && (!Number.isInteger(firstRow) || !Number.isInteger(lastRow) || firstRow < 2 || lastRow < firstRow)) {
      setMessage('Indica un rango de filas válido. La fila inicial debe ser 2 o mayor y no superar la fila final.');
      return;
    }
    const selected = readings.filter(item => item.sheetName === sheetName
      && (mode === 'sheet' || (item.rowNumber >= firstRow && item.rowNumber <= lastRow)));
    if (!selected.length) {
      setMessage('No hay registros en esa hoja o rango para asignar.');
      return;
    }
    const movingRecords = selected.filter(reading => reading.workerUid && reading.workerUid !== workerUid);
    if (movingRecords.length && !window.confirm(
      `${movingRecords.length.toLocaleString()} registros ya están asignados a otro trabajador. ¿Reasignarlos? Los cambios offline que aún no se hayan sincronizado en el dispositivo anterior no llegarán a Supabase.`,
    )) return;

    setBusy(true);
    const assignmentId = crypto.randomUUID();
    const worker = workers.find(item => item.uid === workerUid);
    const supabase = getSupabase();
    try {
      const { error: assignmentError } = await supabase.from('assignments').insert({
        id: assignmentId,
        cycle_id: activeCycle.id,
        worker_uid: workerUid,
        worker_name: worker?.name || worker?.email || '',
        sheet_name: sheetName,
        mode,
        start_row: mode === 'range' ? firstRow : null,
        end_row: mode === 'range' ? lastRow : null,
        record_count: selected.length,
        status: 'assigning',
        created_at: Date.now(),
        created_by: user.id,
      });
      if (assignmentError) throw assignmentError;
      for (let offset = 0; offset < selected.length; offset += BATCH_SIZE) {
        const ids = selected.slice(offset, offset + BATCH_SIZE).map(reading => reading.id);
        const { error } = await supabase.from('readings').update({
          worker_uid: workerUid, assignment_id: assignmentId, assigned_at: Date.now(),
        }).in('id', ids);
        if (error) throw error;
      }
      const { error: finishError } = await supabase.from('assignments').update({ status: 'active', assigned_at: Date.now() }).eq('id', assignmentId);
      if (finishError) throw finishError;
      setMessage(`Asignación guardada en Supabase: ${selected.length.toLocaleString()} registros de “${sheetName}” para ${worker?.name || worker?.email || 'el trabajador'}.`);
    } catch (error) {
      try { await supabase.from('assignments').update({ status: 'failed' }).eq('id', assignmentId); } catch { /* Preserve the original failure. */ }
      console.error('Assignment failed', error);
      const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
      setMessage(`No se pudo completar la asignación${code ? ` (${code})` : ''}. Revisa la conexión y políticas RLS; la asignación quedó marcada como incompleta.`);
    } finally {
      setBusy(false);
    }
  }

  async function exportCurrent() {
    if (!activeCycle) {
      setMessage('Selecciona un ciclo.');
      return;
    }
    setBusy(true);
    try {
      if (!navigator.onLine) throw new Error('Conéctate a internet para descargar las lecturas más recientes desde Supabase.');
      const template = await localDB.templates.get(activeCycle.id);
      if (!template) throw new Error('La plantilla original está en el navegador que la importó. Usa ese mismo dispositivo para exportar.');
      const currentReadings = await fetchCycleReadings(activeCycle.id);
      const incompleteCount = currentReadings.filter(item => item.reading.trim() === '' && item.novelty.trim() === '').length;
      const suffix = incompleteCount ? 'avance' : 'final';
      const filename = `${safeDocumentPart(activeCycle.name)}_${suffix}.xlsx`;
      await exportWorkbook(template.bytes, currentReadings, filename);
      setMessage(incompleteCount
        ? `Excel de avance exportado con la plantilla original. Quedan ${incompleteCount.toLocaleString()} registros sin lectura ni motivo de novedad.`
        : 'Excel final exportado con la plantilla original y todas las lecturas completadas.');
    } catch (error) {
      console.error('Export failed', error);
      setMessage(error instanceof Error ? error.message : 'No se pudo exportar el Excel.');
    } finally {
      setBusy(false);
    }
  }

  async function attachSourceTemplate() {
    if (!activeCycle || !sourceTemplateFile) return;
    setBusy(true);
    try {
      if (!activeCycle.sourceFingerprint) {
        throw new Error('Este ciclo es anterior a la verificación de plantillas. Exporta desde el navegador donde se importó o crea un ciclo nuevo con el archivo original.');
      }
      const bytes = await sourceTemplateFile.arrayBuffer();
      const fingerprint = await fingerprintFile(bytes);
      if (fingerprint !== activeCycle.sourceFingerprint) {
        throw new Error('El archivo seleccionado no coincide con la plantilla original de este ciclo.');
      }
      await localDB.templates.put({ cycleId: activeCycle.id, name: sourceTemplateFile.name, bytes });
      setHasTemplate(true);
      setSourceTemplateFile(null);
      setMessage('Plantilla original vinculada localmente. No se envió ningún archivo al servidor.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No se pudo verificar la plantilla.');
    } finally {
      setBusy(false);
    }
  }

  async function doSignOut() {
    await getSupabase().auth.signOut();
    router.push('/login');
  }

  const previewCounts = preview?.dataSheetNames.map(name => ({
    name,
    count: preview.rows.filter(row => row.sheetName === name).length,
  })) || [];

  if (authStatus !== 'allowed') {
    return <main className="worker-layout" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 20 }}>
      <section className="panel" style={{ width: '100%', maxWidth: 520, padding: 30 }}>
        <div className="brand" style={{ color: '#14213a', marginBottom: 20 }}><span className="brand-mark">S</span> sinucode</div>
        <h1 style={{ fontSize: 23, marginBottom: 10 }}>{authStatus === 'checking' ? 'Verificando acceso…' : 'No tienes acceso de administrador'}</h1>
        <p className="muted" style={{ lineHeight: 1.6 }}>
          {authStatus === 'checking'
            ? 'Estamos validando tu sesión.'
            : accountRole
              ? `Tu cuenta tiene el rol “${accountRole}”. Ingresa desde el espacio correspondiente.`
              : 'La cuenta inició sesión, pero no tiene un rol autorizado. Ingresa con el correo administrador configurado para Supabase.'}
        </p>
        {authStatus === 'forbidden' && <button className="btn secondary" style={{ marginTop: 12 }} onClick={doSignOut}><LogOut size={16} /> Cerrar sesión</button>}
      </section>
    </main>;
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">S</span> sinucode</div>
        <div>
          <div className="small" style={{ color: '#8192ad', padding: '0 12px', marginBottom: 9 }}>ESPACIO DE TRABAJO</div>
          <nav className="nav">
            <a className="active" href="/admin"><LayoutDashboard size={17} /> Panel general</a>
            <a href="#ciclos"><BookOpen size={17} /> Ciclos y Excel</a>
            <a href="#trabajadores"><Users size={17} /> Trabajadores</a>
            <a href="#asignar"><Users size={17} /> Asignaciones</a>
            <a href="#lecturas"><FileSpreadsheet size={17} /> Lecturas</a>
          </nav>
        </div>
        <div className="sidebar-foot">
          <div className="row"><ShieldCheck size={16} /> Panel de administrador</div>
          <div style={{ marginTop: 8 }}>{user?.email || 'Verificando sesión…'}</div>
          <button className="btn secondary" style={{ marginTop: 15, width: '100%', background: '#1c2b46', color: '#e8eff9', borderColor: '#34435d' }} onClick={doSignOut}>
            <LogOut size={15} /> Cerrar sesión
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <div className="eyebrow">OPERACIONES / RESUMEN</div>
            <h1 className="page-title">Panel de control</h1>
            <div className="muted" style={{ fontSize: 13, marginTop: 7 }}>Importa plantillas, asigna hojas y consolida las lecturas en el libro original.</div>
          </div>
          <div className="row">
            <span className={`pill ${supabaseConfigured ? 'green' : 'orange'}`}>
              {supabaseConfigured ? <><Wifi size={13} /> Supabase configurado</> : <><WifiOff size={13} /> Falta configurar</>}
            </span>
            <button className="btn secondary" onClick={() => location.reload()} title="Actualizar"><RefreshCw size={16} /></button>
            <div className="avatar">{(user?.email || 'AD').slice(0, 2).toUpperCase()}</div>
          </div>
        </header>

        {!supabaseConfigured && <div className="notice warn" style={{ marginBottom: 20 }}>Configura las variables de Supabase para importar datos y sincronizar.</div>}
        {message && <div className="notice" role="status" style={{ marginBottom: 20 }}>{message}</div>}

        <div className="cards">
          {[
            { label: 'Registros del ciclo', value: readings.length, foot: activeCycle?.name || 'Selecciona un ciclo', icon: <FileSpreadsheet size={19} /> },
            { label: 'Completados', value: completed, foot: `${readings.length ? Math.round(completed / readings.length * 100) : 0}% de los registros`, icon: <CheckCircle2 size={19} /> },
            { label: 'Trabajadores conectados', value: onlineWorkers, foot: `de ${activeWorkers.length} trabajadores activos`, icon: <Users size={19} /> },
            { label: 'Pendientes', value: pending, foot: 'Sin lectura ni motivo de novedad', icon: <Cloud size={19} /> },
          ].map(card => (
            <div className="card" key={card.label}>
              <div className="row between"><span className="stat-label">{card.label}</span><span className="stat-icon">{card.icon}</span></div>
              <div className="stat-value">{Number(card.value).toLocaleString()}</div>
              <div className="stat-foot">{card.foot}</div>
            </div>
          ))}
        </div>

        <section className="panel" id="ciclos" style={{ marginBottom: 20 }}>
          <div className="row between" style={{ marginBottom: 18, flexWrap: 'wrap' }}>
            <div>
              <h2 className="panel-title">Importar plantilla Excel</h2>
              <p className="panel-sub" style={{ marginBottom: 0 }}>Las filas se guardan en Supabase. El archivo original se conserva localmente para exportar con sus hojas y formato.</p>
            </div>
            <span className="pill blue"><FileSpreadsheet size={13} /> .XLSX</span>
          </div>
          <form onSubmit={handleImportSubmit}>
            <div className="form-grid">
              <label className="field">Nombre del ciclo
                <input className="input" value={cycleName} onChange={event => { setCycleName(event.target.value); setPreview(null); }} placeholder="Ej. Ciclo octubre 2026" />
              </label>
              <label className="field">Archivo Excel (.xlsx)
                <input className="input" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required onChange={event => { setFile(event.target.files?.[0] || null); setPreview(null); }} />
              </label>
            </div>
            <div className="row between" style={{ marginTop: 16, flexWrap: 'wrap' }}>
              <span className="muted small">Reconoce NOMBRE, DIRECCION, RUTA, CONSEC, BARRIO, CONTRATO, PRODUCTO, MEDIDOR y LECTURA en cualquier orden.</span>
              <button className="btn" disabled={busy || !file || !supabaseConfigured || !user}>
                <Upload size={16} />{busy ? 'Procesando…' : preview ? `Confirmar ${preview.rows.length.toLocaleString()} registros` : 'Validar y previsualizar'}
              </button>
            </div>
          </form>
          {preview && <div style={{ marginTop: 20 }}>
            <h3 style={{ fontSize: 15, marginBottom: 10 }}>Vista previa · {preview.name}</h3>
            <div className="table-wrap" style={{ marginBottom: 14 }}>
              <table><thead><tr><th>Hoja</th><th>Registros</th></tr></thead>
                <tbody>{previewCounts.map(item => <tr key={item.name}><td>{item.name}</td><td>{item.count.toLocaleString()}</td></tr>)}
                  <tr><th>Total</th><th>{preview.rows.length.toLocaleString()}</th></tr></tbody>
              </table>
            </div>
            <div className="table-wrap">
              <table><thead><tr><th>Hoja</th><th>Fila</th>{previewFields.map(field => <th key={field}>{field}</th>)}</tr></thead>
                <tbody>{preview.rows.slice(0, 8).map(row => <tr key={row.id}>
                  <td>{row.sheetName}</td><td>{row.rowNumber}</td>
                  {previewFields.map(field => <td key={field}>{String(row.base[field] ?? '—')}</td>)}
                </tr>)}</tbody>
              </table>
            </div>
          </div>}
        </section>

        <section className="panel" id="trabajadores" style={{ marginBottom: 20 }}>
          <div className="row between" style={{ marginBottom: 18, flexWrap: 'wrap' }}>
            <div>
              <h2 className="panel-title">Trabajadores</h2>
              <p className="panel-sub" style={{ marginBottom: 0 }}>Crea los nombres que aparecerán en el ingreso y en las asignaciones.</p>
            </div>
            <span className="pill blue"><Users size={13} /> {activeWorkers.length} activos</span>
          </div>
          <form className="row" onSubmit={createWorker} style={{ alignItems: 'end', flexWrap: 'wrap', marginBottom: 18 }}>
            <label className="field" style={{ flex: '1 1 280px' }}>Nombre del trabajador
              <input className="input" value={newWorkerName} onChange={event => setNewWorkerName(event.target.value)} maxLength={100} placeholder="Ej. María Pérez" required />
            </label>
            <button className="btn" disabled={creatingWorker || !newWorkerName.trim()}><Plus size={16} />{creatingWorker ? 'Creando…' : 'Crear trabajador'}</button>
          </form>
          <div className="table-wrap">
            <table><thead><tr><th>Nombre</th><th>Estado</th><th>Registros en este ciclo</th><th>Acciones</th></tr></thead>
              <tbody>{workers.map(worker => <tr key={worker.uid}>
                <td>{worker.name || worker.email || 'Sin nombre'}</td>
                <td><span className={`pill ${worker.active === false ? 'gray' : 'green'}`}>{worker.active === false ? 'Inactivo' : 'Activo'}</span></td>
                <td>{readings.filter(reading => reading.workerUid === worker.uid).length.toLocaleString()}</td>
                <td><div className="row" style={{ flexWrap: 'nowrap' }}>
                  <button type="button" className="btn secondary" onClick={() => {
                    setDetailWorkerFilter(worker.uid);
                    setDetailSheetFilter('all');
                    setDetailStatusFilter('all');
                    setSearch('');
                    document.getElementById('lecturas')?.scrollIntoView({ behavior: 'smooth' });
                  }}><Eye size={15} /> Ver detalle</button>
                  <button type="button" className="btn secondary" onClick={() => void setWorkerActive(worker, worker.active === false)}>{worker.active === false ? 'Activar' : 'Desactivar'}</button>
                </div></td>
              </tr>)}
                {!workers.length && <tr><td colSpan={4} style={{ textAlign: 'center', padding: 24, color: '#68758b' }}>Todavía no hay trabajadores. Crea el primero arriba.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel" id="asignar" style={{ marginBottom: 20 }}>
          <h2 className="panel-title">Asignar hojas o rangos</h2>
          <p className="panel-sub">La asignación y cada registro quedan vinculados al trabajador en Supabase.</p>
          <form onSubmit={assign}>
            <div className="form-grid">
              <label className="field">Ciclo
                <select className="input" value={cycleId} onChange={event => { setSelectedCycle(event.target.value); setSheetName(''); }} required>
                  <option value="">Seleccionar ciclo</option>
                  {readyCycles.map(cycle => <option key={cycle.id} value={cycle.id}>{cycle.name}</option>)}
                </select>
              </label>
              <label className="field">Trabajador
                <select className="input" value={workerUid} onChange={event => setWorkerUid(event.target.value)} required>
                  <option value="">Seleccionar trabajador</option>
                  {activeWorkers.map(worker => <option key={worker.uid} value={worker.uid}>{worker.name || worker.email}</option>)}
                </select>
              </label>
              <label className="field">Hoja del Excel
                <select className="input" value={sheetName} onChange={event => setSheetName(event.target.value)} required>
                  <option value="">Seleccionar hoja</option>
                  {(activeCycle?.dataSheetNames || activeCycle?.sheetNames || []).map(name => <option key={name} value={name}>{name} · {readings.filter(reading => reading.sheetName === name).length.toLocaleString()} registros</option>)}
                </select>
              </label>
              <label className="field">Tipo de asignación
                <select className="input" value={mode} onChange={event => setMode(event.target.value as 'sheet' | 'range')}>
                  <option value="sheet">Hoja completa</option><option value="range">Rango de filas</option>
                </select>
              </label>
              {mode === 'range' && <>
                <label className="field">Fila inicial<input className="input" type="number" min="2" value={startRow} onChange={event => setStartRow(event.target.value)} /></label>
                <label className="field">Fila final<input className="input" type="number" min={startRow} value={endRow} onChange={event => setEndRow(event.target.value)} /></label>
              </>}
            </div>
            <div className="row between" style={{ marginTop: 16, flexWrap: 'wrap' }}>
              <span className="muted small">Las referencias mantienen el nombre de hoja y número de fila del archivo de origen.</span>
              <button className="btn" disabled={busy || !readings.length || !activeWorkers.length || !sheetName}><Plus size={16} /> Asignar registros</button>
            </div>
          </form>
          <div style={{ marginTop: 24 }}>
            <h3 style={{ fontSize: 15, marginBottom: 10 }}>Asignaciones de este ciclo</h3>
            <div className="table-wrap">
              <table><thead><tr><th>Trabajador</th><th>Hoja</th><th>Asignados</th><th>Diligenciados</th><th>Pendientes</th><th>Avance</th></tr></thead>
                <tbody>{assignmentSummary.map(item => {
                  const worker = workers.find(candidate => candidate.uid === item.workerUid);
                  const percent = item.total ? Math.round(item.completed / item.total * 100) : 0;
                  return <tr key={`${item.workerUid}-${item.sheetName}`}>
                    <td>{worker?.name || worker?.email || 'Trabajador inactivo'}</td><td>{item.sheetName}</td>
                    <td>{item.total.toLocaleString()}</td><td>{item.completed.toLocaleString()}</td>
                    <td>{(item.total - item.completed).toLocaleString()}</td><td>{percent}%</td>
                  </tr>;
                })}
                  {!assignmentSummary.length && <tr><td colSpan={6} style={{ textAlign: 'center', padding: 22, color: '#68758b' }}>Todavía no hay hojas asignadas para este ciclo.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="panel" id="lecturas">
          <div className="row between" style={{ marginBottom: 18, flexWrap: 'wrap' }}>
            <div>
              <div className="eyebrow">{activeCycle?.name || 'SIN CICLO SELECCIONADO'}</div>
              <h2 className="panel-title">Detalle y exportación</h2>
              <p className="panel-sub" style={{ marginBottom: 0 }}>Consulta el avance del ciclo y exporta el libro original con sus hojas y formato.</p>
            </div>
            <div style={{ textAlign: 'right' }}>
              <button className="btn" disabled={busy || !hasTemplate || !activeCycle} onClick={exportCurrent}><ArrowDownToLine size={16} />{busy ? 'Preparando…' : 'Exportar Excel'}</button>
              <div className="small muted" style={{ marginTop: 7 }}>{hasTemplate ? 'Plantilla original disponible en este dispositivo' : 'Vincula la plantilla original para habilitar la exportación'}</div>
            </div>
          </div>
          <div className="cards" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(145px,1fr))', marginBottom: 18 }}>
            <div className="card"><div className="stat-label">Registros</div><div className="stat-value">{readings.length.toLocaleString()}</div></div>
            <div className="card"><div className="stat-label">Asignados</div><div className="stat-value">{assignedCount.toLocaleString()}</div></div>
            <div className="card"><div className="stat-label">Sin asignar</div><div className="stat-value">{(readings.length - assignedCount).toLocaleString()}</div></div>
            <div className="card"><div className="stat-label">Diligenciados</div><div className="stat-value">{completed.toLocaleString()}</div></div>
            <div className="card"><div className="stat-label">Pendientes</div><div className="stat-value">{pending.toLocaleString()}</div></div>
          </div>
          <div className="form-grid" style={{ gridTemplateColumns: 'minmax(220px,2fr) repeat(3,minmax(145px,1fr))', marginBottom: 16 }}>
            <label className="field">Buscar en el ciclo
              <input className="input" value={search} onChange={event => setSearch(event.target.value)} placeholder="Nombre, contrato, dirección, medidor…" />
            </label>
            <label className="field">Hoja
              <select className="input" value={detailSheetFilter} onChange={event => setDetailSheetFilter(event.target.value)}><option value="all">Todas las hojas</option>{sheetOptions.map(name => <option key={name} value={name}>{name}</option>)}</select>
            </label>
            <label className="field">Trabajador
              <select className="input" value={detailWorkerFilter} onChange={event => setDetailWorkerFilter(event.target.value)}><option value="all">Todos</option><option value="unassigned">Sin asignar</option>{workers.map(worker => <option key={worker.uid} value={worker.uid}>{worker.name || worker.email}</option>)}</select>
            </label>
            <label className="field">Estado
              <select className="input" value={detailStatusFilter} onChange={event => setDetailStatusFilter(event.target.value as typeof detailStatusFilter)}><option value="all">Todos</option><option value="assigned">Asignados</option><option value="unassigned">Sin asignar</option><option value="completed">Diligenciados</option><option value="pending">Pendientes</option></select>
            </label>
          </div>
          <p className="small muted" style={{ marginBottom: 10 }}>{detailWorkerFilter === 'all'
            ? 'Vista general del ciclo.'
            : `Vista individual: ${workers.find(worker => worker.uid === detailWorkerFilter)?.name || 'trabajador seleccionado'}.`} Mostrando {filtered.length} resultados (máximo 100 por búsqueda).</p>
          <div className="table-wrap">
            <table><thead><tr><th>CONSEC.</th><th>CONTRATO</th><th>NOMBRE</th><th>HOJA</th><th>LECTURA</th><th>ASIGNACIÓN</th><th>ESTADO</th></tr></thead>
              <tbody>{filtered.map(reading => <tr key={reading.id}>
                <td>{String(reading.base.CONSEC ?? '—')}</td><td>{String(reading.base.CONTRATO ?? '—')}</td><td>{String(reading.base.NOMBRE ?? '—')}</td>
                <td>{reading.sheetName}</td><td>{reading.reading || <span className="muted">Pendiente</span>}</td>
                <td>{workers.find(worker => worker.uid === reading.workerUid)?.name || workers.find(worker => worker.uid === reading.workerUid)?.email || <span className="muted">Sin asignar</span>}</td>
                <td><span className={`pill ${reading.reading || reading.novelty ? 'green' : 'orange'}`}>{reading.reading || reading.novelty ? 'Completado' : 'Pendiente'}</span></td>
              </tr>)}
                {!filtered.length && <tr><td colSpan={7} style={{ textAlign: 'center', padding: 35, color: '#68758b' }}>{supabaseConfigured ? 'No hay lecturas para mostrar. Importa un Excel o selecciona un ciclo.' : 'Configura Supabase para comenzar con datos reales.'}</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="small muted" style={{ marginTop: 18, lineHeight: 1.6 }}><CircleHelp size={14} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 5 }} />La exportación usa el archivo original local y marca como “avance” los libros que tengan registros pendientes.</div>
          {activeCycle && !hasTemplate && <div className="row" style={{ marginTop: 14, flexWrap: 'wrap' }}>
            <label className="field" style={{ flex: '1 1 260px' }}>Vincular plantilla original en este dispositivo
              <input className="input" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={event => setSourceTemplateFile(event.target.files?.[0] || null)} />
            </label>
            <button className="btn secondary" type="button" disabled={busy || !sourceTemplateFile} onClick={attachSourceTemplate}>Verificar y guardar localmente</button>
          </div>}
        </section>
      </main>
    </div>
  );
}
