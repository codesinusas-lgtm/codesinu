'use client';

import { getSupabase } from './supabase/client';
import { localDB, type PendingAdminDelete, type Reading } from './localdb';
import { readingToDb } from './supabase/data';

const ADMIN_SYNC_BATCH = 400;

async function updateAdminCounts(cycleIds: Set<string>, assignmentIds: Set<string>) {
  const supabase = getSupabase();
  for (const cycleId of cycleIds) {
    const { count, error } = await supabase.from('readings').select('id', { count: 'exact', head: true }).eq('cycle_id', cycleId);
    if (error) throw error;
    const { error: updateError } = await supabase.from('cycles').update({ record_count: count || 0 }).eq('id', cycleId);
    if (updateError) throw updateError;
  }
  for (const assignmentId of assignmentIds) {
    const { count, error } = await supabase.from('readings').select('id', { count: 'exact', head: true }).eq('assignment_id', assignmentId);
    if (error) throw error;
    const { error: updateError } = await supabase.from('assignments').update({ record_count: count || 0 }).eq('id', assignmentId);
    if (updateError) throw updateError;
  }
}

/** Pushes admin reading changes stored in IndexedDB after connectivity returns. */
export async function syncPendingAdminChanges(ownerUid: string) {
  if (!navigator.onLine) return { synced: 0, offline: true };
  const supabase = getSupabase();
  let synced = 0;
  const deletes = await localDB.pendingAdminDeletes.where('ownerUid').equals(ownerUid).toArray();
  for (let offset = 0; offset < deletes.length; offset += ADMIN_SYNC_BATCH) {
    const batch = deletes.slice(offset, offset + ADMIN_SYNC_BATCH);
    const ids = batch.map(item => item.id);
    const { error } = await supabase.from('readings').delete().in('id', ids);
    if (error) throw error;
    const { data: remaining, error: verifyError } = await supabase.from('readings').select('id').in('id', ids);
    if (verifyError) throw verifyError;
    if (remaining?.length) throw new Error(`Supabase no confirmó ${remaining.length} eliminaciones.`);
    await updateAdminCounts(new Set(batch.map(item => item.cycleId)), new Set(batch.flatMap(item => item.assignmentId ? [item.assignmentId] : [])));
    await localDB.pendingAdminDeletes.bulkDelete(ids);
    synced += batch.length;
  }

  const upserts = await localDB.pendingAdminUpserts.where('ownerUid').equals(ownerUid).toArray();
  for (let offset = 0; offset < upserts.length; offset += ADMIN_SYNC_BATCH) {
    const batch = upserts.slice(offset, offset + ADMIN_SYNC_BATCH);
    const { data, error } = await supabase.from('readings').upsert(batch.map(item => readingToDb(item.reading)), { onConflict: 'id' }).select('id');
    if (error) throw error;
    if ((data || []).length !== batch.length) throw new Error('Supabase no confirmó todos los cambios administrativos.');
    await updateAdminCounts(new Set(batch.map(item => item.reading.cycleId)), new Set(batch.flatMap(item => item.reading.assignmentId ? [item.reading.assignmentId] : [])));
    await localDB.transaction('rw', localDB.pendingAdminUpserts, localDB.readings, async () => {
      for (const item of batch) {
        const current = await localDB.readings.get(item.id);
        if (current?.version === item.reading.version) await localDB.readings.update(item.id, { synced: true });
        const queued = await localDB.pendingAdminUpserts.get(item.id);
        if (queued?.queuedAt === item.queuedAt) await localDB.pendingAdminUpserts.delete(item.id);
      }
    });
    synced += batch.length;
  }
  return { synced, offline: false };
}

export async function queueAdminReadingDelete(reading: Reading, ownerUid: string) {
  const tombstone: PendingAdminDelete = {
    id: reading.id, cycleId: reading.cycleId, assignmentId: reading.assignmentId || null, ownerUid, queuedAt: Date.now(),
  };
  await localDB.transaction('rw', localDB.readings, localDB.pendingAdminDeletes, localDB.pendingAdminUpserts, async () => {
    await localDB.pendingAdminUpserts.delete(reading.id);
    await localDB.readings.delete(reading.id);
    await localDB.pendingAdminDeletes.put(tombstone);
  });
}

export async function queueAdminReadingUpsert(reading: Reading, ownerUid: string) {
  const saved = { ...reading, updatedAt: Date.now(), synced: false, version: (reading.version || 0) + 1 };
  await localDB.transaction('rw', localDB.readings, localDB.pendingAdminDeletes, localDB.pendingAdminUpserts, async () => {
    await localDB.pendingAdminDeletes.delete(reading.id);
    await localDB.readings.put(saved);
    await localDB.pendingAdminUpserts.put({ id: saved.id, ownerUid, reading: saved, queuedAt: Date.now() });
  });
  return saved;
}

export async function syncPendingReadings(uid: string) {
  if (!navigator.onLine) return { synced: 0, offline: true };
  const pending = await localDB.readings.filter(reading => !reading.synced && reading.workerUid === uid).toArray();
  const supabase = getSupabase();
  let count = 0;
  for (const item of pending) {
    const { data, error } = await supabase.from('readings').update({
      reading: item.reading,
      observation: item.observation,
      novelty: item.novelty,
      updated_at: item.updatedAt,
      version: item.version,
    }).eq('id', item.id).eq('worker_uid', uid).select('id');
    if (error) throw error;
    if (!data?.length) throw new Error(`Supabase no confirmó la lectura ${item.id}.`);
    const current = await localDB.readings.get(item.id);
    if (current?.version === item.version) await localDB.readings.update(item.id, { synced: true, workerUid: uid });
    count++;
  }
  return { synced: count, offline: false };
}

export async function fetchAssignedReadings(uid: string): Promise<Reading[]> {
  const { fetchWorkerReadings } = await import('./supabase/data');
  return fetchWorkerReadings(uid);
}
