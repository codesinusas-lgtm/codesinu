'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { useRouter } from 'next/navigation';
import {
  ArrowDownToLine, BookOpen, CheckCircle2, CircleHelp, Cloud, FileSpreadsheet,
  Eye, LayoutDashboard, LogOut, Plus, RefreshCw, ShieldCheck, Upload, Users, Wifi, WifiOff, Pencil, Trash2,
} from 'lucide-react';
import { getSupabase, supabaseConfigured } from '@/lib/supabase/client';
import { fetchCycleReadings, readingToDb } from '@/lib/supabase/data';
import { ADMIN_EMAIL, hasAdminAccess } from '@/lib/auth-roles';
import { exportWorkbook, parseWorkbook, type ImportedRow } from '@/lib/excel';
import { localDB, type CachedCycle, type Reading } from '@/lib/localdb';
import { queueAdminReadingDelete, queueAdminReadingUpsert, syncPendingAdminChanges } from '@/lib/sync';

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
  sourceCounts: Record<string, number>;
  fingerprint: string;
};

const BATCH_SIZE = 400;
const DETAIL_PAGE_SIZE = 100;
const previewFields = ['NOMBRE', 'DIRECCION', 'RUTA', 'CONSEC', 'CONTRATO', 'MEDIDOR', 'LECTURA'];

function safeDocumentPart(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'ciclo';
}

function normalizeWorkerName(value: string) {
  return value.trim().replace(/\s+/g, ' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es');
}

function findDuplicateReadings(readings: Reading[]) {
  const sheetCounts = new Map<string, number>();
  for (const reading of readings) sheetCounts.set(reading.sheetName, (sheetCounts.get(reading.sheetName) || 0) + 1);
  const masterSheet = [...sheetCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const groups = new Map<string, Reading[]>();
  for (const reading of readings) {
    const product = String(reading.base.PRODUCTO ?? '').trim();
    if (!product) continue;
    const group = groups.get(product) || [];
    group.push(reading);
    groups.set(product, group);
  }
  const duplicateGroups: Array<{ canonical: Reading; copies: Reading[]; merged: Reading }> = [];
  let conflictingGroups = 0;
  for (const group of groups.values()) {
    if (group.length < 2 || !group.some(row => row.sheetName === masterSheet) || !group.some(row => row.sheetName !== masterSheet)) continue;
    const masterRows = group.filter(row => row.sheetName === masterSheet);
    const canonical = masterRows[0];
    const readingsSet = new Set(group.map(row => row.reading.trim()).filter(Boolean));
    const workerSet = new Set(group.map(row => row.workerUid).filter((uid): uid is string => Boolean(uid)));
    const identityConflict = ['CONTRATO', 'MEDIDOR', 'CONSEC', 'NOMBRE', 'DIRECCION'].some(field =>
      new Set(group.map(row => String(row.base[field] ?? '').trim().toLocaleLowerCase('es')).filter(Boolean)).size > 1,
    );
    if (masterRows.length !== 1 || readingsSet.size > 1 || workerSet.size > 1 || identityConflict) {
      conflictingGroups += 1;
      continue;
    }
    const copies = group.filter(row => row.id !== canonical.id);
    const uniqueText = (values: string[]) => [...new Set(values.map(value => value.trim()).filter(Boolean))].join(' · ');
    const assignedCopy = group.find(row => row.workerUid);
    duplicateGroups.push({
      canonical,
      copies,
      merged: {
        ...canonical,
        workerUid: canonical.workerUid || assignedCopy?.workerUid || null,
        assignmentId: canonical.assignmentId || assignedCopy?.assignmentId || null,
        assignedAt: canonical.assignedAt || assignedCopy?.assignedAt,
        reading: canonical.reading.trim() ? canonical.reading : [...readingsSet][0] || '',
        observation: uniqueText(group.map(row => row.observation)),
        novelty: uniqueText(group.map(row => row.novelty)),
      },
    });
  }
  return {
    masterSheet,
    duplicateGroups,
    conflictingGroups,
    duplicateCount: duplicateGroups.reduce((total, group) => total + group.copies.length, 0),
  };
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
  const [detailPage, setDetailPage] = useState(0);
  const [editingReading, setEditingReading] = useState<Reading | null>(null);
  const [savingReading, setSavingReading] = useState(false);
  const [online, setOnline] = useState(true);
  const [supabaseReachable, setSupabaseReachable] = useState(false);
  const [pendingChanges, setPendingChanges] = useState(0);
  const router = useRouter();

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  const refreshPendingCount = useCallback(async () => {
    if (!user) return;
    const [deletes, upserts] = await Promise.all([
      localDB.pendingAdminDeletes.where('ownerUid').equals(user.id).count(),
      localDB.pendingAdminUpserts.where('ownerUid').equals(user.id).count(),
    ]);
    setPendingChanges(deletes + upserts);
  }, [user]);

  useEffect(() => { void refreshPendingCount(); }, [refreshPendingCount]);

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
        setSupabaseReachable(false);
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
        setSupabaseReachable(false);
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
      setSupabaseReachable(true);
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
      void (async () => {
        try {
          await syncPendingAdminChanges(user.id);
        } finally {
          await refreshPendingCount();
        }
        return fetchCycleReadings(cycleId);
      })()
        .then(async rows => {
          const merged = [] as Reading[];
          const toCache = [] as Reading[];
          const deletedIds = new Set((await localDB.pendingAdminDeletes.where('cycleId').equals(cycleId).toArray()).map(item => item.id));
          for (const remote of rows) {
            if (deletedIds.has(remote.id)) continue;
            const local = await localDB.readings.get(remote.id);
            const row = local && !local.synced && local.updatedAt > remote.updatedAt ? local : remote;
            merged.push(row);
            if (row === remote) toCache.push(remote);
          }
          await localDB.readings.bulkPut(toCache);
          const remoteIds = new Set(rows.map(row => row.id));
          const cached = await localDB.readings.where('cycleId').equals(cycleId).toArray();
          const queuedUpserts = new Set((await localDB.pendingAdminUpserts.where('ownerUid').equals(user.id).toArray()).map(item => item.id));
          const staleIds = cached.filter(row => !remoteIds.has(row.id) && !queuedUpserts.has(row.id)).map(row => row.id);
          if (staleIds.length) await localDB.readings.bulkDelete(staleIds);
          setSupabaseReachable(true);
          if (active) setReadings(merged);
        })
        .catch(error => {
          setSupabaseReachable(false);
          console.error('Supabase cycle readings load failed', error);
          if (active) {
            void showCachedReadings();
            setMessage(`No se pudieron cargar las lecturas nuevas desde Supabase (${error.code || error.message}). Mostrando copia local.`);
          }
        });
    };
    void refresh();
    void refreshPendingCount();
    const channel = supabase.channel(`cycle-readings:${cycleId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'readings', filter: `cycle_id=eq.${cycleId}` }, refresh)
      .subscribe();
    window.addEventListener('online', refresh);
    return () => {
      active = false;
      window.removeEventListener('online', refresh);
      void supabase.removeChannel(channel);
    };
  }, [cycleId, user, refreshPendingCount]);

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
  const duplicateAnalysis = useMemo(() => findDuplicateReadings(readings), [readings]);
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
    }), [readings, search, detailSheetFilter, detailWorkerFilter, detailStatusFilter]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / DETAIL_PAGE_SIZE));
  const visibleReadings = filtered.slice(detailPage * DETAIL_PAGE_SIZE, (detailPage + 1) * DETAIL_PAGE_SIZE);

  useEffect(() => { setDetailPage(0); }, [search, detailSheetFilter, detailWorkerFilter, detailStatusFilter, cycleId]);
  useEffect(() => { if (detailPage >= pageCount) setDetailPage(Math.max(0, pageCount - 1)); }, [detailPage, pageCount]);

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
      const workerNames = [...new Set(preview.rows.map(row => row.workerName?.trim().replace(/\s+/g, ' ')).filter((name): name is string => Boolean(name)))];
      const workerByName = new Map<string, Worker>();
      for (const name of workerNames) {
        const key = normalizeWorkerName(name);
        const existing = workers.find(worker => normalizeWorkerName(worker.name) === key);
        if (existing) {
          if (existing.active === false) {
            const { error } = await supabase.from('workers').update({ active: true }).eq('uid', existing.uid);
            if (error) throw error;
            existing.active = true;
          }
          workerByName.set(key, existing);
          continue;
        }
        const created: Worker = { uid: crypto.randomUUID(), name, email: '', role: 'worker', active: true };
        const { error } = await supabase.from('workers').insert({
          uid: created.uid, name: created.name, email: '', role: 'worker', active: true,
          created_at: Date.now(), created_by: user.id,
        });
        if (error) throw error;
        workerByName.set(key, created);
      }
      if (workerNames.length) {
        const importedWorkers = [...workerByName.values()];
        setWorkers(current => {
          const merged = new Map(current.map(worker => [worker.uid, worker]));
          importedWorkers.forEach(worker => merged.set(worker.uid, worker));
          return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'));
        });
        await localDB.workers.bulkPut(importedWorkers.map(worker => ({ uid: worker.uid, name: worker.name, active: worker.active !== false })));
      }
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

      const assignmentGroups = new Map<string, { worker: Worker; sheetName: string; rows: ImportedRow[]; id: string }>();
      for (const row of preview.rows) {
        const name = row.workerName?.trim().replace(/\s+/g, ' ');
        if (!name) continue;
        const worker = workerByName.get(normalizeWorkerName(name));
        if (!worker) continue;
        const key = `${worker.uid}::${row.sheetName}`;
        const group = assignmentGroups.get(key) || {
          worker, sheetName: row.sheetName, rows: [],
          id: `${preview.id}__assignment__${encodeURIComponent(worker.uid)}__${encodeURIComponent(row.sheetName)}`,
        };
        group.rows.push(row);
        assignmentGroups.set(key, group);
      }
      const assignedAt = Date.now();
      if (assignmentGroups.size) {
        const assignmentRows = [...assignmentGroups.values()].map(group => ({
          id: group.id, cycle_id: preview.id, worker_uid: group.worker.uid,
          worker_name: group.worker.name, sheet_name: group.sheetName, mode: 'sheet',
          start_row: null, end_row: null, record_count: group.rows.length,
          status: 'assigning', created_at: assignedAt, created_by: user.id,
        }));
        const { error } = await supabase.from('assignments').upsert(assignmentRows, { onConflict: 'id' });
        if (error) throw error;
        let assignedRecords = 0;
        for (const group of assignmentGroups.values()) {
          for (let offset = 0; offset < group.rows.length; offset += BATCH_SIZE) {
            const batch = group.rows.slice(offset, offset + BATCH_SIZE);
            const { error: assignError } = await supabase.from('readings').update({
              worker_uid: group.worker.uid, assignment_id: group.id, assigned_at: assignedAt,
            }).in('id', batch.map(row => row.id));
            if (assignError) throw assignError;
            assignedRecords += batch.length;
          }
        }
        const { error: activateError } = await supabase.from('assignments')
          .update({ status: 'active', assigned_at: assignedAt }).in('id', [...assignmentGroups.values()].map(group => group.id));
        if (activateError) throw activateError;
        setMessage(`Lecturas guardadas. ${workerNames.length} trabajadores y ${assignedRecords.toLocaleString()} lecturas asignadas…`);
      }

      const { error: finishError } = await supabase.from('cycles').update({ import_status: 'active', imported_at: Date.now() }).eq('id', preview.id);
      if (finishError) throw finishError;
      setSelectedCycle(preview.id);
      setFile(null);
      setPreview(null);
      const assignedCount = preview.rows.filter(row => row.workerName).length;
      setMessage(`Importación completada: ${preview.rows.length.toLocaleString()} registros, ${workerByName.size} trabajadores creados o reutilizados y ${assignedCount.toLocaleString()} lecturas asignadas automáticamente. El archivo original sigue guardado solo en este navegador.`);
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

  function startNewReading() {
    if (!activeCycle) {
      setMessage('Selecciona o importa un ciclo antes de agregar lecturas.');
      return;
    }
    const sheet = sheetName && sheetOptions.includes(sheetName)
      ? sheetName
      : activeCycle.dataSheetNames?.[0] || activeCycle.sheetNames[0] || '';
    const rowsOnSheet = readings.filter(item => item.sheetName === sheet);
    const rowNumber = Math.max(1, ...rowsOnSheet.map(item => item.rowNumber)) + 1;
    const sample = rowsOnSheet[rowsOnSheet.length - 1];
    const base = Object.fromEntries(Object.keys(sample?.base || {}).map(key => [key, null])) as Reading['base'];
    for (const key of ['NOMBRE', 'DIRECCION', 'RUTA', 'CONSEC', 'BARRIO', 'CONTRATO', 'PRODUCTO', 'MEDIDOR']) {
      if (!(key in base)) base[key] = null;
    }
    setEditingReading({
      id: `${activeCycle.id}__${encodeURIComponent(sheet)}__${rowNumber}`,
      cycleId: activeCycle.id, sheetName: sheet, rowNumber, workerUid: null, assignmentId: null,
      base, reading: '', observation: '', novelty: '', updatedAt: Date.now(), synced: false, version: 0,
    });
  }

  async function saveAdminReading(event: React.FormEvent) {
    event.preventDefault();
    if (!editingReading || !user) {
      setMessage('No se pudo preparar el cambio. Inicia sesión como administrador.');
      return;
    }
    const isNew = !readings.some(item => item.id === editingReading.id);
    setSavingReading(true);
    try {
      const saved = await queueAdminReadingUpsert(editingReading, user.id);
      setReadings(current => isNew ? [...current, saved] : current.map(item => item.id === saved.id ? saved : item));
      setEditingReading(null);
      if (navigator.onLine) {
        await syncPendingAdminChanges(user.id);
        const canonical = await localDB.readings.get(saved.id);
        if (canonical) setReadings(current => current.map(item => item.id === canonical.id ? canonical : item));
        setSupabaseReachable(true);
        setMessage(isNew ? 'Lectura guardada en este dispositivo y sincronizada con Supabase.' : 'Cambios guardados en este dispositivo y sincronizados con Supabase.');
      } else {
        setMessage('Lectura guardada en este dispositivo. Se enviará a Supabase cuando vuelva la conexión.');
      }
      await refreshPendingCount();
    } catch (error) {
      console.error('Admin reading save failed', error);
      const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
      setSupabaseReachable(false);
      await refreshPendingCount();
      setMessage(`El cambio quedó guardado localmente, pero Supabase no confirmó la sincronización${code ? ` (${code})` : ''}. Se reintentará al reconectar.`);
    } finally {
      setSavingReading(false);
    }
  }

  async function deleteAdminReading(reading: Reading) {
    if (!user) return;
    const identifier = String(reading.base.NOMBRE || reading.base.CONTRATO || `fila ${reading.rowNumber}`);
    if (!window.confirm(`¿Eliminar la lectura ${identifier} de la hoja “${reading.sheetName}”? Se ocultará ahora y se sincronizará con Supabase al recuperar conexión.`)) return;
    setBusy(true);
    try {
      await queueAdminReadingDelete(reading, user.id);
      setReadings(current => current.filter(item => item.id !== reading.id));
      if (navigator.onLine) {
        await syncPendingAdminChanges(user.id);
        setSupabaseReachable(true);
        setMessage('Lectura eliminada localmente y de Supabase.');
      } else {
        setMessage('Lectura eliminada de este dispositivo. Se confirmará en Supabase al recuperar conexión.');
      }
      await refreshPendingCount();
    } catch (error) {
      console.error('Admin reading deletion failed', error);
      setSupabaseReachable(false);
      await refreshPendingCount();
      setMessage(`El borrado está guardado localmente y pendiente de Supabase${error instanceof Error ? `: ${error.message}` : '.'}`);
    } finally {
      setBusy(false);
    }
  }

  async function deleteAllCycleReadings() {
    if (!activeCycle || !user || !readings.length) return;
    const count = readings.length;
    if (!window.confirm(`Se eliminarán ${count.toLocaleString()} lecturas del ciclo “${activeCycle.name}”. Se conservarán las tablas, el ciclo, los trabajadores y las asignaciones. Si estás sin conexión, se aplicará en Supabase al volver la señal. ¿Continuar?`)) return;
    setBusy(true);
    try {
      const deletedAt = Date.now();
      const tombstones = readings.map(reading => ({
        id: reading.id, cycleId: reading.cycleId, assignmentId: reading.assignmentId || null,
        ownerUid: user.id, queuedAt: deletedAt,
      }));
      await localDB.transaction('rw', localDB.readings, localDB.pendingAdminDeletes, localDB.pendingAdminUpserts, async () => {
        await localDB.pendingAdminDeletes.bulkPut(tombstones);
        await localDB.pendingAdminUpserts.bulkDelete(readings.map(reading => reading.id));
        await localDB.readings.bulkDelete(readings.map(reading => reading.id));
      });
      setReadings([]);
      setDetailPage(0);
      setCycles(current => current.map(cycle => cycle.id === activeCycle.id ? { ...cycle, recordCount: 0 } : cycle));
      await localDB.cycles.update(activeCycle.id, { recordCount: 0 });
      if (navigator.onLine) {
        await syncPendingAdminChanges(user.id);
        setSupabaseReachable(true);
        setMessage(`${count.toLocaleString()} lecturas eliminadas de Supabase y del dispositivo. Las tablas y asignaciones se conservaron.`);
      } else {
        setMessage(`${count.toLocaleString()} lecturas eliminadas de este dispositivo. Quedaron en cola para Supabase; las tablas y asignaciones se conservaron.`);
      }
      await refreshPendingCount();
    } catch (error) {
      console.error('Bulk reading deletion failed', error);
      setSupabaseReachable(false);
      await refreshPendingCount();
      setMessage(`El borrado local quedó pendiente de sincronización${error instanceof Error ? `: ${error.message}` : '.'}`);
    } finally {
      setBusy(false);
    }
  }

  async function unifyCycleDuplicates() {
    if (!activeCycle || !navigator.onLine) {
      setMessage('Conéctate a internet para unificar el ciclo en Supabase.');
      return;
    }
    const current = findDuplicateReadings(readings);
    if (!current.duplicateCount) {
      setMessage('No hay copias seguras para unificar en este ciclo.');
      return;
    }
    const detail = `${current.duplicateCount.toLocaleString()} copias seguras se eliminarán después de unir sus lecturas y asignaciones en “${current.masterSheet}”. ${current.conflictingGroups ? `${current.conflictingGroups} grupos con diferencias se conservarán para revisión.` : ''}`;
    if (!window.confirm(`${detail}\n\n¿Continuar?`)) return;
    setBusy(true);
    try {
      const freshRows = await fetchCycleReadings(activeCycle.id);
      const analysis = findDuplicateReadings(freshRows);
      if (!analysis.duplicateCount) {
        setReadings(freshRows);
        setMessage('Las copias ya no están duplicadas en Supabase.');
        return;
      }
      const updatedAt = Date.now();
      const mergedRows = analysis.duplicateGroups.map(group => ({
        ...group.merged,
        updatedAt,
        synced: true,
        version: group.canonical.version + 1,
      }));
      const duplicateIds = analysis.duplicateGroups.flatMap(group => group.copies.map(copy => copy.id));
      for (let offset = 0; offset < mergedRows.length; offset += BATCH_SIZE) {
        const { error } = await getSupabase().from('readings')
          .upsert(mergedRows.slice(offset, offset + BATCH_SIZE).map(readingToDb), { onConflict: 'id' });
        if (error) throw error;
      }
      for (let offset = 0; offset < duplicateIds.length; offset += BATCH_SIZE) {
        const { error } = await getSupabase().from('readings').delete()
          .in('id', duplicateIds.slice(offset, offset + BATCH_SIZE));
        if (error) throw error;
      }

      const removed = new Set(duplicateIds);
      const replacementById = new Map(mergedRows.map(row => [row.id, row]));
      const finalRows = freshRows.filter(row => !removed.has(row.id)).map(row => replacementById.get(row.id) || row);
      await localDB.readings.bulkDelete(duplicateIds);
      await localDB.readings.bulkPut(mergedRows);
      setReadings(finalRows);

      const assignmentCounts = new Map<string, number>();
      for (const row of finalRows) if (row.assignmentId) assignmentCounts.set(row.assignmentId, (assignmentCounts.get(row.assignmentId) || 0) + 1);
      const { data: assignments, error: assignmentLoadError } = await getSupabase().from('assignments').select('id').eq('cycle_id', activeCycle.id);
      if (assignmentLoadError) throw assignmentLoadError;
      for (const assignment of assignments || []) {
        const { error } = await getSupabase().from('assignments').update({ record_count: assignmentCounts.get(assignment.id) || 0 }).eq('id', assignment.id);
        if (error) throw error;
      }
      const { error: cycleUpdateError } = await getSupabase().from('cycles').update({ record_count: finalRows.length }).eq('id', activeCycle.id);
      if (cycleUpdateError) throw cycleUpdateError;
      setCycles(currentCycles => currentCycles.map(cycle => cycle.id === activeCycle.id ? { ...cycle, recordCount: finalRows.length } : cycle));
      setMessage(`Ciclo unificado: ${duplicateIds.length.toLocaleString()} copias eliminadas; ${finalRows.length.toLocaleString()} lecturas únicas conservadas.${analysis.conflictingGroups ? ` Se conservaron ${analysis.conflictingGroups} grupos con conflictos para revisión.` : ''}`);
    } catch (error) {
      console.error('Cycle duplicate unification failed', error);
      setMessage(`No se pudo completar la unificación${error instanceof Error ? `: ${error.message}` : ''}. Revisa Supabase y vuelve a cargar el ciclo antes de reintentar.`);
    } finally {
      setBusy(false);
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
    count: preview.sourceCounts[name] ?? preview.rows.filter(row => row.sheetName === name).length,
  })) || [];
  const previewWorkerCounts = useMemo(() => {
    const grouped = new Map<string, { name: string; count: number; sheets: Set<string> }>();
    for (const row of preview?.rows || []) {
      const name = row.workerName?.trim();
      if (!name) continue;
      const key = normalizeWorkerName(name);
      const entry = grouped.get(key) || { name, count: 0, sheets: new Set<string>() };
      entry.count += 1;
      entry.sheets.add(row.sheetName);
      grouped.set(key, entry);
    }
    return [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }, [preview]);

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
            <div className="connection-status" role="status">
              <span className={`pill ${!online ? 'orange' : supabaseReachable ? 'green' : 'gray'}`}>
                {!online ? <><WifiOff size={13} /> Sin conexión · guardado local</> : supabaseReachable ? <><Wifi size={13} /> Supabase conectado</> : <><Wifi size={13} /> Supabase verificando</>}
              </span>
              {pendingChanges > 0 && <span className="pill orange">{pendingChanges.toLocaleString()} cambios por sincronizar</span>}
            </div>
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
              <span className="muted small">Reconoce los campos de lectura y asigna automáticamente por columna TRABAJADOR/LECTOR o por pestañas de trabajadores.</span>
              <button className="btn" disabled={busy || !file || !supabaseConfigured || !user}>
                <Upload size={16} />{busy ? 'Procesando…' : preview ? `Confirmar ${preview.rows.length.toLocaleString()} registros` : 'Validar y previsualizar'}
              </button>
            </div>
          </form>
          {preview && <div style={{ marginTop: 20 }}>
            <h3 style={{ fontSize: 15, marginBottom: 10 }}>Vista previa · {preview.name}</h3>
            <div className="notice" style={{ marginBottom: 14 }}>Se guardarán {preview.rows.length.toLocaleString()} lecturas únicas. Las pestañas identificadas como copias de trabajadores se usarán para crear/reutilizar sus cuentas y asignarles las filas correspondientes; las copias no se duplicarán en la base de datos.</div>
            <div className="table-wrap" style={{ marginBottom: 14 }}>
              <table><thead><tr><th>Pestaña del Excel</th><th>Filas válidas</th></tr></thead>
                <tbody>{previewCounts.map(item => <tr key={item.name}><td>{item.name}</td><td>{item.count.toLocaleString()}</td></tr>)}
                </tbody>
              </table>
            </div>
            <h3 style={{ fontSize: 15, marginBottom: 10 }}>Trabajadores y asignaciones detectados</h3>
            {previewWorkerCounts.length ? <div className="table-wrap" style={{ marginBottom: 14 }}>
              <table><thead><tr><th>Trabajador</th><th>Hojas</th><th>Lecturas que se asignarán</th></tr></thead>
                <tbody>{previewWorkerCounts.map(item => <tr key={normalizeWorkerName(item.name)}><td>{item.name}</td><td>{[...item.sheets].join(', ')}</td><td>{item.count.toLocaleString()}</td></tr>)}</tbody>
              </table>
            </div> : <div className="notice warn" style={{ marginBottom: 14 }}>No se detectaron trabajadores en una columna ni en pestañas duplicadas de la hoja principal. Las lecturas quedarían sin asignar.</div>}
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
              <p className="panel-sub" style={{ marginBottom: 0 }}>El administrador puede agregar, editar, eliminar y exportar las lecturas completas.</p>
            </div>
            <div className="admin-reading-actions">
              {duplicateAnalysis.duplicateCount > 0 && <button className="btn secondary" type="button" disabled={busy} onClick={() => void unifyCycleDuplicates()}><RefreshCw size={15} />Unificar {duplicateAnalysis.duplicateCount.toLocaleString()} duplicados</button>}
              <button className="btn secondary" type="button" disabled={!activeCycle} onClick={startNewReading}><Plus size={16} />Agregar lectura</button>
              <button className="btn danger" type="button" disabled={busy || !activeCycle || readings.length === 0} onClick={() => void deleteAllCycleReadings()}><Trash2 size={15} />Eliminar todas ({readings.length.toLocaleString()})</button>
              <button className="btn" disabled={busy || !hasTemplate || !activeCycle} onClick={exportCurrent}><ArrowDownToLine size={16} />{busy ? 'Preparando…' : 'Exportar Excel'}</button>
              <div className="small muted" style={{ marginTop: 7 }}>{hasTemplate ? 'Plantilla original disponible en este dispositivo' : 'Vincula la plantilla original para habilitar la exportación'}</div>
            </div>
          </div>
          {duplicateAnalysis.conflictingGroups > 0 && <div className="notice warn" style={{ marginBottom: 16 }}>{duplicateAnalysis.conflictingGroups} grupos tienen lecturas o trabajadores distintos entre sus copias y se conservarán para revisión.</div>}
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
            : `Vista individual: ${workers.find(worker => worker.uid === detailWorkerFilter)?.name || 'trabajador seleccionado'}.`} Mostrando {filtered.length ? detailPage * DETAIL_PAGE_SIZE + 1 : 0}–{Math.min((detailPage + 1) * DETAIL_PAGE_SIZE, filtered.length)} de {filtered.length.toLocaleString()} resultados.</p>
          <div className="table-wrap">
            <table><thead><tr><th>CONSEC.</th><th>CONTRATO</th><th>NOMBRE</th><th>HOJA</th><th>LECTURA</th><th>ASIGNACIÓN</th><th>ESTADO</th><th>ACCIONES</th></tr></thead>
              <tbody>{visibleReadings.map(reading => <tr key={reading.id}>
                <td>{String(reading.base.CONSEC ?? '—')}</td><td>{String(reading.base.CONTRATO ?? '—')}</td><td>{String(reading.base.NOMBRE ?? '—')}</td>
                <td>{reading.sheetName}</td><td>{reading.reading || <span className="muted">Pendiente</span>}</td>
                <td>{workers.find(worker => worker.uid === reading.workerUid)?.name || workers.find(worker => worker.uid === reading.workerUid)?.email || <span className="muted">Sin asignar</span>}</td>
                <td><span className={`pill ${reading.reading || reading.novelty ? 'green' : 'orange'}`}>{reading.reading || reading.novelty ? 'Completado' : 'Pendiente'}</span></td>
                <td><div className="row" style={{ flexWrap: 'nowrap' }}><button className="btn secondary" type="button" onClick={() => setEditingReading({ ...reading, base: { ...reading.base } })}><Pencil size={14} />Editar</button><button className="btn secondary" type="button" disabled={busy} onClick={() => void deleteAdminReading(reading)}><Trash2 size={14} />Eliminar</button></div></td>
              </tr>)}
                {!filtered.length && <tr><td colSpan={8} style={{ textAlign: 'center', padding: 35, color: '#68758b' }}>{supabaseConfigured ? 'No hay lecturas para mostrar. Importa un Excel o selecciona un ciclo.' : 'Configura Supabase para comenzar con datos reales.'}</td></tr>}
              </tbody>
            </table>
          </div>
          {filtered.length > DETAIL_PAGE_SIZE && <div className="row between" style={{ marginTop: 14 }}><span className="small muted">Página {detailPage + 1} de {pageCount}</span><div className="row"><button className="btn secondary" type="button" disabled={detailPage === 0} onClick={() => setDetailPage(page => Math.max(0, page - 1))}>Anterior</button><button className="btn secondary" type="button" disabled={detailPage + 1 >= pageCount} onClick={() => setDetailPage(page => Math.min(pageCount - 1, page + 1))}>Siguiente</button></div></div>}
          <div className="small muted" style={{ marginTop: 18, lineHeight: 1.6 }}><CircleHelp size={14} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 5 }} />La exportación usa el archivo original local y marca como “avance” los libros que tengan registros pendientes.</div>
          {activeCycle && !hasTemplate && <div className="row" style={{ marginTop: 14, flexWrap: 'wrap' }}>
            <label className="field" style={{ flex: '1 1 260px' }}>Vincular plantilla original en este dispositivo
              <input className="input" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={event => setSourceTemplateFile(event.target.files?.[0] || null)} />
            </label>
            <button className="btn secondary" type="button" disabled={busy || !sourceTemplateFile} onClick={attachSourceTemplate}>Verificar y guardar localmente</button>
          </div>}
        </section>
        {editingReading && <div role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !savingReading) setEditingReading(null); }} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: '#101d3580', display: 'grid', placeItems: 'center', padding: 16 }}>
          <form className="panel" onSubmit={saveAdminReading} style={{ width: 'min(760px, 100%)', maxHeight: '90vh', overflow: 'auto' }}>
            <div className="row between" style={{ marginBottom: 18 }}><div><h2 className="panel-title">{readings.some(item => item.id === editingReading.id) ? 'Editar lectura completa' : 'Agregar lectura'}</h2><p className="panel-sub" style={{ margin: '5px 0 0' }}>Hoja {editingReading.sheetName} · fila {editingReading.rowNumber}</p></div><button className="btn secondary" type="button" disabled={savingReading} onClick={() => setEditingReading(null)}>Cerrar</button></div>
            <div className="form-grid">
              {Object.entries(editingReading.base).map(([key, value]) => <label className="field" key={key}>{key}<input className="input" value={value == null ? '' : String(value)} onChange={event => setEditingReading(current => current ? { ...current, base: { ...current.base, [key]: event.target.value || null } } : current)} /></label>)}
              <label className="field">LECTURA<input className="input" value={editingReading.reading} onChange={event => setEditingReading(current => current ? { ...current, reading: event.target.value } : current)} /></label>
              <label className="field">OBSERVACIÓN<input className="input" value={editingReading.observation} onChange={event => setEditingReading(current => current ? { ...current, observation: event.target.value } : current)} /></label>
              <label className="field">MOTIVO DE NOVEDAD<input className="input" value={editingReading.novelty} onChange={event => setEditingReading(current => current ? { ...current, novelty: event.target.value } : current)} /></label>
            </div>
            <div className="row between" style={{ marginTop: 20 }}><span className="small muted">{editingReading.workerUid ? 'Asignada: conserva el trabajador actual.' : 'La lectura nueva queda sin asignar.'}</span><button className="btn" disabled={savingReading || !navigator.onLine}><CheckCircle2 size={16} />{savingReading ? 'Guardando…' : 'Guardar en Supabase'}</button></div>
          </form>
        </div>}
      </main>
    </div>
  );
}
