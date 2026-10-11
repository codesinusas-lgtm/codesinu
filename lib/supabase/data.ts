import type { Reading } from '../localdb';
import { getSupabase } from './client';

type DbReading = {
  id: string;
  cycle_id: string;
  sheet_name: string;
  row_number: number;
  worker_uid: string | null;
  assignment_id: string | null;
  assigned_at: number | null;
  base: Record<string, string | number | null>;
  reading: string;
  observation: string;
  novelty: string;
  updated_at: number;
  version: number;
};

export function readingFromDb(row: DbReading): Reading {
  return {
    id: row.id,
    cycleId: row.cycle_id,
    sheetName: row.sheet_name,
    rowNumber: row.row_number,
    workerUid: row.worker_uid,
    assignmentId: row.assignment_id,
    assignedAt: row.assigned_at ?? undefined,
    base: row.base || {},
    reading: row.reading || '',
    observation: row.observation || '',
    novelty: row.novelty || '',
    updatedAt: Number(row.updated_at || 0),
    synced: true,
    version: Number(row.version || 0),
  };
}

export function readingToDb(reading: Reading): DbReading {
  return {
    id: reading.id,
    cycle_id: reading.cycleId,
    sheet_name: reading.sheetName,
    row_number: reading.rowNumber,
    worker_uid: reading.workerUid || null,
    assignment_id: reading.assignmentId || null,
    assigned_at: reading.assignedAt ?? null,
    base: reading.base,
    reading: reading.reading,
    observation: reading.observation,
    novelty: reading.novelty,
    updated_at: reading.updatedAt || Date.now(),
    version: reading.version || 0,
  };
}

export async function fetchCycleReadings(cycleId: string) {
  const supabase = getSupabase();
  const rows: DbReading[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('readings').select('*')
      .eq('cycle_id', cycleId).order('sheet_name').order('row_number')
      .range(from, from + 999);
    if (error) throw error;
    const page = (data || []) as DbReading[];
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows.map(readingFromDb);
}

export async function fetchWorkerReadings(workerUid: string) {
  const supabase = getSupabase();
  const rows: DbReading[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('readings').select('*')
      .eq('worker_uid', workerUid).order('sheet_name').order('row_number')
      .range(from, from + 999);
    if (error) throw error;
    const page = (data || []) as DbReading[];
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows.map(readingFromDb);
}
