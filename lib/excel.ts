import ExcelJS from 'exceljs';
import type { Reading } from './localdb';

export type SpreadsheetCell = string | number | null;
export type ImportedRow = {
  id: string;
  cycleId: string;
  sheetName: string;
  rowNumber: number;
  base: Record<string, SpreadsheetCell>;
  reading: string;
  observation: string;
  novelty: string;
  updatedAt: number;
  synced: boolean;
  version: number;
};

function readingCellValue(rawValue: string): string | number | null {
  const value = rawValue.trim();
  if (!value) return null;
  if (/^[-+]?(0|[1-9]\d*)([.,]\d+)?$/.test(value)) {
    return Number(value.replace(',', '.'));
  }
  return rawValue;
}

const recognizedHeaders = new Set([
  'NOMBRE', 'DIRECCION', 'RUTA', 'CONSEC', 'BARRIO', 'CONTRATO',
  'PRODUCTO', 'MEDIDOR', 'LECTURA', 'OBSERVACION', 'MOTIVO_NOVEDAD',
]);

function headerName(value: ExcelJS.CellValue, column: number): string {
  const raw = cellToScalar(value);
  const name = String(raw ?? `COLUMNA_${column}`).trim();
  const normalized = name.toLocaleUpperCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return recognizedHeaders.has(normalized) ? normalized : name;
}

/** Converts ExcelJS values to JSON-compatible scalar values. */
function cellToScalar(value: ExcelJS.CellValue): SpreadsheetCell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  if (value instanceof Date) return value.toISOString();
  if ('result' in value) return cellToScalar(value.result as ExcelJS.CellValue) ?? '';
  if ('richText' in value) return value.richText.map(part => part.text).join('');
  if ('text' in value) return String(value.text ?? '');
  if ('hyperlink' in value) return String(value.hyperlink ?? '');
  if ('error' in value) return String(value.error ?? '');
  return String(value);
}

function findHeader(worksheet: ExcelJS.Worksheet) {
  const lastRow = Math.min(worksheet.rowCount, 30);
  for (let rowNumber = 1; rowNumber <= lastRow; rowNumber++) {
    const row = worksheet.getRow(rowNumber);
    const headers: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, column) => {
      headers[column] = headerName(cell.value, column);
    });
    const nameColumn = headers.findIndex(header => header?.toLocaleUpperCase('es') === 'NOMBRE');
    const readingColumn = headers.findIndex(header => header?.toLocaleUpperCase('es') === 'LECTURA');
    if (nameColumn > 0 && readingColumn > 0) return { rowNumber, headers, readingColumn };
  }
  return null;
}

export async function parseWorkbook(file: File, cycleId: string) {
  if (!file.name.toLocaleLowerCase().endsWith('.xlsx')) {
    throw new Error('El archivo debe tener formato .xlsx.');
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer() as never);

  const rows: ImportedRow[] = [];
  const sheetNames: string[] = [];
  const dataSheetNames: string[] = [];
  const skippedSheets: string[] = [];

  workbook.eachSheet(worksheet => {
    sheetNames.push(worksheet.name);
    const detected = findHeader(worksheet);
    if (!detected) {
      skippedSheets.push(worksheet.name);
      return;
    }
    dataSheetNames.push(worksheet.name);

    const duplicateHeaders = detected.headers.slice(1).filter((header, index, values) =>
      header && values.findIndex(value => value?.toLocaleUpperCase('es') === header.toLocaleUpperCase('es')) !== index,
    );
    if (duplicateHeaders.length) {
      throw new Error(`La hoja “${worksheet.name}” tiene encabezados duplicados: ${[...new Set(duplicateHeaders)].join(', ')}.`);
    }

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber <= detected.rowNumber) return;
      const base: Record<string, SpreadsheetCell> = {};
      detected.headers.forEach((header, column) => {
        if (column > 0 && header) base[header] = cellToScalar(row.getCell(column).value);
      });
      if (!Object.values(base).some(value => value !== null && value !== '')) return;

      const readingValue = cellToScalar(row.getCell(detected.readingColumn).value);
      rows.push({
        id: `${cycleId}__${encodeURIComponent(worksheet.name)}__${rowNumber}`,
        cycleId,
        sheetName: worksheet.name,
        rowNumber,
        base,
        reading: readingValue === null ? '' : String(readingValue),
        observation: '',
        novelty: '',
        updatedAt: Date.now(),
        synced: false,
        version: 0,
      });
    });
  });

  if (!dataSheetNames.length) {
    throw new Error('No encontré hojas con encabezados NOMBRE y LECTURA dentro de las primeras 30 filas.');
  }
  if (!rows.length) throw new Error('Encontré encabezados válidos, pero no hay registros para importar.');
  return { rows, sheetNames, dataSheetNames, skippedSheets };
}

export async function exportWorkbook(
  templateBytes: ArrayBuffer,
  readings: Reading[],
  filename: string,
  selectedSheetNames?: string[],
) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(templateBytes as never);
  const selected = selectedSheetNames ? new Set(selectedSheetNames) : null;
  const map = new Map(readings.map(reading => [`${reading.sheetName}__${reading.rowNumber}`, reading]));

  workbook.eachSheet(sheet => {
    if (selected && !selected.has(sheet.name)) return;
    const detected = findHeader(sheet);
    if (!detected) return;
    const headerRow = sheet.getRow(detected.rowNumber);
    const headers: Record<string, number> = {};
    headerRow.eachCell((cell, column) => {
      headers[headerName(cell.value, column).toLocaleUpperCase('es')] = column;
    });
    const readingColumn = headers.LECTURA;
    if (!readingColumn) return;

    const ensureColumn = (label: string) => {
      if (headers[label]) return headers[label];
      const column = sheet.columnCount + 1;
      headerRow.getCell(column).value = label;
      headers[label] = column;
      return column;
    };

    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber <= detected.rowNumber) return;
      const reading = map.get(`${sheet.name}__${rowNumber}`);
      if (!reading) return;
      row.getCell(readingColumn).value = readingCellValue(reading.reading);
      if (reading.observation) row.getCell(ensureColumn('OBSERVACION')).value = reading.observation;
      if (reading.novelty) row.getCell(ensureColumn('MOTIVO_NOVEDAD')).value = reading.novelty;
    });
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
