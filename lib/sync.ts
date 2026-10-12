'use client';

import { getSupabase } from './supabase/client';
import { localDB, type Reading } from './localdb';

export async function syncPendingReadings(uid: string) {
  if (!navigator.onLine) return { synced: 0, offline: true };
  const pending = await localDB.readings.filter(reading => !reading.synced && (!reading.workerUid || reading.workerUid === uid)).toArray();
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
