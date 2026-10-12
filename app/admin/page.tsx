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
        setMessage('Sin conexión. Mostrando el último estado guardado en este dispositivo.');
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
        setMessage(`Supabase no pudo cargar el panel (${failed.code || failed.message}).`);
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
            setMessage(`No se pudieron cargar las lecturas nuevas desde Supabase. Mostrando copia local.`);
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
      setMessage(`Vista previa lista: ${parsed.rows.length.toLocaleString()} registros en ${parsed.dataSheetNames.length} hojas.`);
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
      setMessage('Conéctate a internet antes de guardar el ciclo en Supabase.');
      return;
    }
    setBusy(true);
    setMessage(`Guardando y asignando registros en Supabase…`);
    const supabase = getSupabase();
    try {
      // 1. Identificar trabajadores según el nombre de las hojas secundarias del Excel
      const workerNames = preview.sheetNames.filter(name => name !== preview.dataSheetNames[0]);
      const workerByName = new Map<string, Worker>();

      for (const name of workerNames) {
        const cleanName = name.trim().replace(/\s+/g, ' ');
        const key = normalizeWorkerName(cleanName);
        let existing = workers.find(worker => normalizeWorkerName(worker.name) === key);
        
        if (!existing) {
          const created: Worker = { uid: crypto.randomUUID(), name: cleanName, email: '', role: 'worker', active: true };
          const { error } = await supabase.from('workers').insert({
            uid: created.uid, name: created.name, email: '', role: 'worker', active: true,
            created_at: Date.now(), created_by: user.id,
          });
          if (!error) existing = created;
        }
        if (existing) workerByName.set(key, existing);
      }

      await localDB.templates.put({ cycleId: preview.id, name: preview.fileName, bytes: preview.bytes });

      // 2. Registrar el ciclo
      const { error: cycleError } = await supabase.from('cycles').upsert({
        id: preview.id,
        name: preview.name,
        status: 'active',
        import_status: 'importing',
        sheet_names: [preview.dataSheetNames[0]], // Dejar la principal como hoja oficial
        dataSheet_names: preview.dataSheetNames,
        source_file_name: preview.fileName,
        source_fingerprint: preview.fingerprint,
        record_count: preview.rows.length,
        created_at: Date.now(),
        created_by: user.id,
      });
      if (cycleError) throw cycleError;

      // 3. Mapear las filas de la hoja principal asignándoles el trabajador correspondiente 
      // si su identificador o contrato coincide con las hojas de los trabajadores.
      const assignmentGroups = new Map<string, { worker: Worker; rows: ImportedRow[]; id: string }>();

      const processedRows = preview.rows.map(row => {
        // Si el row viene marcado de una hoja que lleva el nombre de un trabajador
        const sheetWorker = workerByName.get(normalizeWorkerName(row.sheetName));
        const workerUidVal = sheetWorker ? sheetWorker.uid : null;
        let assignmentIdVal = null;

        if (sheetWorker) {
          assignmentIdVal = `${preview.id}__assignment__${encodeURIComponent(sheetWorker.uid)}`;
          const group = assignmentGroups.get(sheetWorker.uid) || {
            worker: sheetWorker,
            rows: [],
            id: assignmentIdVal,
          };
          group.rows.push(row);
          assignmentGroups.set(sheetWorker.uid, group);
        }

        return {
          ...row,
          sheetName: preview.dataSheetNames[0], // Forzar que pertenezcan a la hoja principal del ciclo
          workerUid: workerUidVal,
          assignmentId: assignmentIdVal,
        };
      });

      // 4. Subir las lecturas a Supabase en lotes
      for (let offset = 0; offset < processedRows.length; offset += BATCH_SIZE) {
        const batchRows = processedRows.slice(offset, offset + BATCH_SIZE).map(row => readingToDb({
          ...row,
          workerUid: row.workerUid,
          assignmentId: row.assignmentId,
          synced: true,
        }));
        const { error } = await supabase.from('readings').upsert(batchRows, { onConflict: 'id' });
        if (error) throw error;
      }

      // 5. Guardar las asignaciones en la base de datos
      if (assignmentGroups.size) {
        const assignmentRows = [...assignmentGroups.values()].map(group => ({
          id: group.id,
          cycle_id: preview.id,
          worker_uid: group.worker.uid,
          worker_name: group.worker.name,
          sheet_name: preview.dataSheetNames[0],
          mode: 'sheet',
          record_count: group.rows.length,
          status: 'active',
          created_at: Date.now(),
          created_by: user.id,
          assigned_at: Date.now(),
        }));
        await supabase.from('assignments').upsert(assignmentRows, { onConflict: 'id' });
      }

      await supabase.from('cycles').update({ import_status: 'active', imported_at: Date.now() }).eq('id', preview.id);

      setSelectedCycle(preview.id);
      setFile(null);
      setPreview(null);
      setMessage(`¡Importación exitosa! Los registros se guardaron en la hoja principal del ciclo y se asignaron a los trabajadores según sus hojas.`);
    } catch (error) {
      console.error('Import failed', error);
      setMessage('La importación quedó incompleta.');
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
      setMessage('Sin conexión.');
      return;
    }
    const name = newWorkerName.trim().replace(/\s+/g, ' ');
    if (!name || !user) return;
    setCreatingWorker(true);
    try {
      const uid = crypto.randomUUID();
      const { error } = await getSupabase().from('workers').insert({
        uid, name, email: '', role: 'worker', active: true, created_at: Date.now(), created_by: user.id,
      });
      if (error) throw error;
      setNewWorkerName('');
      setWorkerUid(uid);
      setMessage(`Trabajador creado: ${name}.`);
    } catch (error) {
      console.error('Worker creation failed', error);
      setMessage('No se pudo crear el trabajador en Supabase.');
    } finally {
      setCreatingWorker(false);
    }
  }

  async function setWorkerActive(worker: Worker, active: boolean) {
    if (!navigator.onLine) return;
    try {
      const { error } = await getSupabase().from('workers').update({ active }).eq('uid', worker.uid);
      if (error) throw error;
      setMessage(`${worker.name} ${active ? 'activado' : 'desactivado'}.`);
    } catch (error) {
      console.error('Worker status update failed', error);
    }
  }

  async function assign(event: React.FormEvent) {
    event.preventDefault();
    if (!navigator.onLine) {
      setMessage('Conéctate a internet para asignar hojas.');
      return;
    }
    if (!activeCycle || !workerUid || !sheetName || !user) {
      setMessage('Selecciona un ciclo, trabajador y hoja.');
      return;
    }
    setBusy(true);
    const assignmentId = crypto.randomUUID();
    const worker = workers.find(item => item.uid === workerUid);
    const supabase = getSupabase();
    try {
      const selected = readings.filter(item => item.sheetName === sheetName);
      const { error: assignmentError } = await supabase.from('assignments').insert({
        id: assignmentId, cycle_id: activeCycle.id, worker_uid: workerUid,
        worker_name: worker?.name || '', sheet_name: sheetName, mode: 'sheet',
        record_count: selected.length, status: 'active', created_at: Date.now(), created_by: user.id, assigned_at: Date.now(),
      });
      if (assignmentError) throw assignmentError;

      for (let offset = 0; offset < selected.length; offset += BATCH_SIZE) {
        const ids = selected.slice(offset, offset + BATCH_SIZE).map(reading => reading.id);
        const { error } = await supabase.from('readings').update({
          worker_uid: workerUid, assignment_id: assignmentId, assigned_at: Date.now(),
        }).in('id', ids);
        if (error) throw error;
      }
      setMessage(`Asignación guardada: ${selected.length.toLocaleString()} registros de “${sheetName}” para ${worker?.name}.`);
    } catch (error) {
      console.error('Assignment failed', error);
      setMessage('No se pudo completar la asignación.');
    } finally {
      setBusy(false);
    }
  }

  async function exportCurrent() {
    if (!activeCycle) return;
    setBusy(true);
    try {
      const template = await localDB.templates.get(activeCycle.id);
      if (!template) throw new Error('La plantilla original no está disponible en este dispositivo.');
      const currentReadings = await fetchCycleReadings(activeCycle.id);
      const incompleteCount = currentReadings.filter(item => item.reading.trim() === '' && item.novelty.trim() === '').length;
      const suffix = incompleteCount ? 'avance' : 'final';
      const filename = `${safeDocumentPart(activeCycle.name)}_${suffix}.xlsx`;
      await exportWorkbook(template.bytes, currentReadings, filename);
      setMessage('Excel exportado correctamente con los datos diligenciados de los trabajadores.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No se pudo exportar el Excel.');
    } finally {
      setBusy(false);
    }
  }

  async function attachSourceTemplate() {
    if (!activeCycle || !sourceTemplateFile) return;
    setBusy(true);
    try {
      const bytes = await sourceTemplateFile.arrayBuffer();
      const fingerprint = await fingerprintFile(bytes);
      await localDB.templates.put({ cycleId: activeCycle.id, name: sourceTemplateFile.name, bytes });
      setHasTemplate(true);
      setSourceTemplateFile(null);
      setMessage('Plantilla original vinculada localmente con éxito.');
    } catch (error) {
      setMessage('No se pudo verificar la plantilla.');
    } finally {
      setBusy(false);
    }
  }

  async function doSignOut() {
    await getSupabase().auth.signOut();
    router.push('/login');
  }

  if (authStatus !== 'allowed') {
    return <main className="worker-layout" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 20 }}>
      <section className="panel" style={{ width: '100%', maxWidth: 520, padding: 30 }}>
        <div className="brand" style={{ color: '#14213a', marginBottom: 20 }}><span className="brand-mark">S</span> sinucode</div>
        <h1 style={{ fontSize: 23, marginBottom: 10 }}>Acceso denegado</h1>
        <p className="muted" style={{ lineHeight: 1.6 }}>No tienes permisos de administrador.</p>
        <button className="btn secondary" style={{ marginTop: 12 }} onClick={doSignOut}><LogOut size={16} /> Cerrar sesión</button>
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
          <div className="row"><ShieldCheck size={16} /> Administrador</div>
          <div style={{ marginTop: 8 }}>{user?.email}</div>
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
            <div className="muted" style={{ fontSize: 13, marginTop: 7 }}>Importación automática con asignación instantánea a trabajadores.</div>
          </div>
          <div className="row">
            <div className="connection-status" role="status">
              <span className={`pill ${!online ? 'orange' : supabaseReachable ? 'green' : 'gray'}`}>
                {!online ? <><WifiOff size={13} /> Sin conexión</> : <><Wifi size={13} /> Conectado</>}
              </span>
            </div>
            <button className="btn secondary" onClick={() => location.reload()} title="Actualizar"><RefreshCw size={16} /></button>
            <div className="avatar">{(user?.email || 'AD').slice(0, 2).toUpperCase()}</div>
          </div>
        </header>

        {message && <div className="notice" role="status" style={{ marginBottom: 20 }}>{message}</div>}

        <div className="cards">
          {[
            { label: 'Registros del ciclo', value: readings.length, foot: activeCycle?.name || 'Selecciona un ciclo', icon: <FileSpreadsheet size={19} /> },
            { label: 'Completados', value: completed, foot: `${readings.length ? Math.round(completed / readings.length * 100) : 0}% del total`, icon: <CheckCircle2 size={19} /> },
            { label: 'Trabajadores activos', value: activeWorkers.length, foot: `${onlineWorkers} en línea`, icon: <Users size={19} /> },
            { label: 'Pendientes', value: pending, foot: 'Sin lectura ni novedad', icon: <Cloud size={19} /> },
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
              <p className="panel-sub" style={{ marginBottom: 0 }}>Las hojas con nombres de trabajadores asignarán automáticamente los registros al confirmar.</p>
            </div>
            <span className="pill blue"><FileSpreadsheet size={13} /> .XLSX</span>
          </div>
          <form onSubmit={handleImportSubmit}>
            <div className="form-grid">
              <label className="field">Nombre del ciclo
                <input className="input" value={cycleName} onChange={event => { setCycleName(event.target.value); setPreview(null); }} placeholder="Ej. Ciclo octubre 2026" />
              </label>
              <label className="field">Archivo Excel (.xlsx)
                <input className="input" type="file" accept=".xlsx" required onChange={event => { setFile(event.target.files?.[0] || null); setPreview(null); }} />
              </label>
            </div>
            <div className="row between" style={{ marginTop: 16, flexWrap: 'wrap' }}>
              <span className="muted small">Reconoce pestañas de trabajadores y distribuye las mediciones instantáneamente.</span>
              <button className="btn" disabled={busy || !file || !supabaseConfigured || !user}>
                <Upload size={16} />{busy ? 'Procesando…' : preview ? `Confirmar e Importar (${preview.rows.length.toLocaleString()})` : 'Validar Excel'}
              </button>
            </div>
          </form>
        </section>

        <section className="panel" id="trabajadores" style={{ marginBottom: 20 }}>
          <div className="row between" style={{ marginBottom: 18, flexWrap: 'wrap' }}>
            <div>
              <h2 className="panel-title">Trabajadores</h2>
              <p className="panel-sub" style={{ marginBottom: 0 }}>Cuentas habilitadas para tomar lecturas en campo.</p>
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
            <table><thead><tr><th>Nombre</th><th>Estado</th><th>Registros asignados</th><th>Acciones</th></tr></thead>
              <tbody>{workers.map(worker => <tr key={worker.uid}>
                <td>{worker.name}</td>
                <td><span className={`pill ${worker.active === false ? 'gray' : 'green'}`}>{worker.active === false ? 'Inactivo' : 'Activo'}</span></td>
                <td>{readings.filter(reading => reading.workerUid === worker.uid).length.toLocaleString()}</td>
                <td><div className="row" style={{ flexWrap: 'nowrap' }}>
                  <button type="button" className="btn secondary" onClick={() => { setDetailWorkerFilter(worker.uid); document.getElementById('lecturas')?.scrollIntoView({ behavior: 'smooth' }); }}><Eye size={15} /> Ver</button>
                  <button type="button" className="btn secondary" onClick={() => void setWorkerActive(worker, worker.active === false)}>{worker.active === false ? 'Activar' : 'Desactivar'}</button>
                </div></td>
              </tr>)}</tbody>
            </table>
          </div>
        </section>

        <section className="panel" id="asignar" style={{ marginBottom: 20 }}>
          <h2 className="panel-title">Asignar hojas o rangos manualmente</h2>
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
                  {activeWorkers.map(worker => <option key={worker.uid} value={worker.uid}>{worker.name}</option>)}
                </select>
              </label>
              <label className="field">Hoja del Excel
                <select className="input" value={sheetName} onChange={event => setSheetName(event.target.value)} required>
                  <option value="">Seleccionar hoja</option>
                  {(activeCycle?.dataSheetNames || activeCycle?.sheetNames || []).map(name => <option key={name} value={name}>{name}</option>)}
                </select>
              </label>
            </div>
            <div className="row between" style={{ marginTop: 16 }}>
              <span className="muted small">Asocia registros de forma manual si lo requieres.</span>
              <button className="btn" disabled={busy || !readings.length || !activeWorkers.length || !sheetName}><Plus size={16} /> Asignar registros</button>
            </div>
          </form>
        </section>

        <section className="panel" id="lecturas">
          <div className="row between" style={{ marginBottom: 18, flexWrap: 'wrap' }}>
            <div>
              <div className="eyebrow">{activeCycle?.name || 'SIN CICLO'}</div>
              <h2 className="panel-title">Detalle y exportación</h2>
            </div>
            <div className="admin-reading-actions">
              <button className="btn" disabled={busy || !hasTemplate || !activeCycle} onClick={exportCurrent}><ArrowDownToLine size={16} />{busy ? 'Preparando…' : 'Exportar Excel con lecturas'}</button>
            </div>
          </div>
          <div className="table-wrap">
            <table><thead><tr><th>CONSEC.</th><th>CONTRATO</th><th>NOMBRE</th><th>HOJA</th><th>LECTURA</th><th>TRABAJADOR</th><th>ESTADO</th></tr></thead>
              <tbody>{visibleReadings.map(reading => <tr key={reading.id}>
                <td>{String(reading.base.CONSEC ?? '—')}</td>
                <td>{String(reading.base.CONTRATO ?? '—')}</td>
                <td>{String(reading.base.NOMBRE ?? '—')}</td>
                <td>{reading.sheetName}</td>
                <td>{reading.reading || <span className="muted">Pendiente</span>}</td>
                <td>{workers.find(worker => worker.uid === reading.workerUid)?.name || <span className="muted">Sin asignar</span>}</td>
                <td><span className={`pill ${reading.reading || reading.novelty ? 'green' : 'orange'}`}>{reading.reading || reading.novelty ? 'Completado' : 'Pendiente'}</span></td>
              </tr>)}</tbody>
            </table>
          </div>
          {activeCycle && !hasTemplate && <div className="row" style={{ marginTop: 14, flexWrap: 'wrap' }}>
            <label className="field" style={{ flex: '1 1 260px' }}>Vincular plantilla original (.xlsx)
              <input className="input" type="file" accept=".xlsx" onChange={event => setSourceTemplateFile(event.target.files?.[0] || null)} />
            </label>
            <button className="btn secondary" type="button" disabled={busy || !sourceTemplateFile} onClick={attachSourceTemplate}>Vincular plantilla</button>
          </div>}
        </section>
      </main>
    </div>
  );
}