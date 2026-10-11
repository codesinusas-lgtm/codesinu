import Dexie, { type EntityTable } from 'dexie';

export type Reading = {
  id: string; cycleId: string; sheetName: string; rowNumber: number; workerUid?: string | null;
  assignmentId?: string | null; assignedAt?: number;
  base: Record<string, string | number | null>; reading: string; observation: string; novelty: string;
  updatedAt: number; synced: boolean; version: number;
};
export type CachedCycle = {
  id: string; name: string; status: string; importStatus?: 'importing' | 'active' | 'failed';
  sheetNames: string[]; dataSheetNames?: string[]; recordCount?: number; createdAt?: number; sourceFingerprint?: string;
};
class ReadingDB extends Dexie {
  readings!: EntityTable<Reading, 'id'>;
  templates!: EntityTable<{cycleId:string; name:string; bytes:ArrayBuffer}, 'cycleId'>;
  workers!: EntityTable<{uid:string; name:string; active:boolean}, 'uid'>;
  cycles!: EntityTable<CachedCycle, 'id'>;
  constructor() {
    super('sinucode-lecturas');
    this.version(1).stores({readings:'id, cycleId, sheetName, workerUid, synced, updatedAt'});
    this.version(2).stores({readings:'id, cycleId, sheetName, workerUid, synced, updatedAt',templates:'cycleId'});
    this.version(3).stores({readings:'id, cycleId, sheetName, workerUid, synced, updatedAt',templates:'cycleId',workers:'uid, name, active'});
    this.version(4).stores({readings:'id, cycleId, sheetName, workerUid, synced, updatedAt',templates:'cycleId',workers:'uid, name, active',cycles:'id, createdAt'});
  }
}
export const localDB = new ReadingDB();
export async function saveLocalReading(reading: Reading) {
  await localDB.readings.put({...reading, updatedAt: Date.now(), synced: false, version: (reading.version || 0) + 1});
}
