export type UserRole = 'admin' | 'worker' | 'lector';
export type AppUser = { uid: string; name: string; email: string; role: UserRole; active: boolean };
export type Cycle = {
  id: string;
  name: string;
  status: 'draft' | 'active' | 'closed';
  importStatus?: 'importing' | 'active' | 'failed';
  sheetNames: string[];
  dataSheetNames?: string[];
  recordCount: number;
  sourceFileName: string;
  sourceFingerprint: string;
  createdAt: number;
  createdBy: string;
};
export type Assignment = {
  id: string;
  cycleId: string;
  workerUid: string;
  workerName?: string;
  sheetName: string;
  startRow?: number | null;
  endRow?: number | null;
  mode: 'sheet' | 'range';
  recordCount: number;
  status: 'assigning' | 'active' | 'failed';
  createdAt: number;
  createdBy: string;
};
