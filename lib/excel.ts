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
  workerName?: string;
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
  'TRABAJADOR', 'LECTOR', 'ASIGNADO_A', 'ASIGNADO A',
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
    if (nameColumn > 0 && readingColumn > 0) return { rowNumber, headers, nameColumn, readingColumn };
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
  const sheetRows = new Map<string, ImportedRow[]>();
  const workerFieldHeaders = new Set(['TRABAJADOR', 'LECTOR', 'ASIGNADO_A', 'ASIGNADO A']);

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

    const workerColumn = detected.headers.findIndex(header => workerFieldHeaders.has(header?.toLocaleUpperCase('es') || ''));
    const parsedSheetRows: ImportedRow[] = [];

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber <= detected.rowNumber) return;
      const repeatedNameHeader = headerName(row.getCell(detected.nameColumn).value, detected.nameColumn).toLocaleUpperCase('es');
      const repeatedReadingHeader = headerName(row.getCell(detected.readingColumn).value, detected.readingColumn).toLocaleUpperCase('es');
      if (repeatedNameHeader === 'NOMBRE' && repeatedReadingHeader === 'LECTURA') return;
      const base: Record<string, SpreadsheetCell> = {};
      detected.headers.forEach((header, column) => {
        if (column > 0 && header) base[header] = cellToScalar(row.getCell(column).value);
      });
      if (!Object.values(base).some(value => value !== null && value !== '')) return;

      const readingValue = cellToScalar(row.getCell(detected.readingColumn).value);
      const imported: ImportedRow = {
        id: `${cycleId}__${encodeURIComponent(worksheet.name)}__${rowNumber}`,
        cycleId,
        sheetName: worksheet.name,
        rowNumber,
        base,
        reading: readingValue === null ? '' : String(readingValue),
        observation: '',
        novelty: '',
        workerName: workerColumn > 0 ? String(cellToScalar(row.getCell(workerColumn).value) ?? '').trim() || undefined : undefined,
        updatedAt: Date.now(),
        synced: false,
        version: 0,
      };
      rows.push(imported);
      parsedSheetRows.push(imported);
    });
    sheetRows.set(worksheet.name, parsedSheetRows);
  });

  if (!dataSheetNames.length) {
    throw new Error('No encontré hojas con encabezados NOMBRE y LECTURA dentro de las primeras 30 filas.');
  }
  if (!rows.length) throw new Error('Encontré encabezados válidos, pero no hay registros para importar.');


  // Identificar la hoja principal sin descartar las filas de ninguna hoja.
  const master = [...sheetRows.entries()]
    .sort((a, b) => b[1].length - a[1].length)[0];

  const workerSheetNames = new Set<string>();
  const workersByReadingId = new Map<string, string>();

  if (master && master[1].length > 0) {
    const uniqueFields = ['PRODUCTO', 'CONTRATO', 'MEDIDOR', 'CONSEC'].filter(field => {
      const values = master[1]
        .map(row => String(row.base[field] ?? '').trim())
        .filter(Boolean);

      return values.length === master[1].length
        && new Set(values).size === values.length;
    });

    const masterIndex = new Map<string, ImportedRow>();

    for (const row of master[1]) {
      for (const field of uniqueFields) {
        masterIndex.set(
          `${field}::${String(row.base[field]).trim()}`,
          row,
        );
      }
    }

    const matchMasterRow = (row: ImportedRow) => {
      for (const field of uniqueFields) {
        const value = String(row.base[field] ?? '').trim();
        const match = value
          ? masterIndex.get(`${field}::${value}`)
          : undefined;

        if (match) return match;
      }

      return undefined;
    };

    for (const [name, sheetRowsForWorker] of sheetRows) {
      if (
        name === master[0]
        || !sheetRowsForWorker.length
        || sheetRowsForWorker.length >= master[1].length
      ) {
        continue;
      }

      const allRowsBelongToMaster =
        sheetRowsForWorker.every(row => matchMasterRow(row));

      if (!allRowsBelongToMaster) continue;

      workerSheetNames.add(name);

      for (const row of sheetRowsForWorker) {
        const masterRow = matchMasterRow(row);
        if (!masterRow) continue;

        // Si la hoja tiene una columna de trabajador, respetarla.
        // De lo contrario, usar el nombre de la hoja.
        const workerName = row.workerName?.trim() || name.trim();

        // La fila física de la hoja de trabajador conserva su identidad.
        row.workerName = workerName;

        const previousWorker = workersByReadingId.get(masterRow.id);

        if (
          previousWorker
          && previousWorker !== workerName
        ) {
          throw new Error(
            `La lectura con PRODUCTO ${masterRow.base.PRODUCTO ?? ''} `
            + `aparece en las pestañas de ${previousWorker} y ${workerName}. `
            + 'Revisa la asignación en el Excel.',
          );
        }

        workersByReadingId.set(masterRow.id, workerName);
      }
    }
  }

  // Vincular también los registros de la hoja principal cuando
  // se puede determinar a qué trabajador pertenecen.
  for (const row of rows) {
    if (
      row.sheetName === master?.[0]
      && !row.workerName
    ) {
      row.workerName = workersByReadingId.get(row.id);
    }
  }

  const sourceCounts = Object.fromEntries(
    [...sheetRows].map(([name, values]) => [name, values.length]),
  );

  // IMPORTANTE:
  // No excluir workerSheetNames. Cada fila física del Excel
  // debe conservarse, aunque coincida con otra hoja.
  return {
    rows,
    sheetNames,
    dataSheetNames,
    skippedSheets,
    sourceCounts,
  };

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
  const fallbackIndex = new Map<string, Reading>();
  const fallbackFields: string[] = [];
  for (const field of ['PRODUCTO', 'CONTRATO', 'MEDIDOR', 'CONSEC']) {
    const byValue = new Map<string, Reading[]>();
    for (const reading of readings) {
      const value = String(reading.base[field] ?? '').trim();
      if (!value) continue;
      const group = byValue.get(value) || [];
      group.push(reading);
      byValue.set(value, group);
    }
    const uniqueEntries = [...byValue.entries()].filter(([, group]) => group.length === 1);
    if (uniqueEntries.length) {
      fallbackFields.push(field);
      for (const [value, group] of uniqueEntries) fallbackIndex.set(`${field}::${value}`, group[0]);
    }
  }
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

    const writeReading = (row: ExcelJS.Row, reading: Reading) => {
      for (const [key, value] of Object.entries(reading.base)) {
        const column = headers[key.toLocaleUpperCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g, '')];
        if (column) row.getCell(column).value = value;
      }
      row.getCell(readingColumn).value = readingCellValue(reading.reading);
      row.getCell(ensureColumn('OBSERVACION')).value = reading.observation || null;
      row.getCell(ensureColumn('MOTIVO_NOVEDAD')).value = reading.novelty || null;
    };

    const sheetReadings = readings.filter(reading => reading.sheetName === sheet.name)
      .sort((a, b) => a.rowNumber - b.rowNumber);
    const directRows = new Map(sheetReadings.map(reading => [reading.rowNumber, reading]));
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber <= detected.rowNumber) return;
      let reading = directRows.get(rowNumber);
      if (!reading) {
        for (const field of fallbackFields) {
          const column = headers[field];
          const value = column ? String(cellToScalar(row.getCell(column).value) ?? '').trim() : '';
          const match = value ? fallbackIndex.get(`${field}::${value}`) : undefined;
          if (match) { reading = match; break; }
        }
      }
      if (reading) writeReading(row, reading);
    });
    for (const reading of sheetReadings) {
      if (reading.rowNumber <= detected.rowNumber) continue;
      if (reading.rowNumber <= sheet.rowCount) continue;
      const isNewRow = reading.rowNumber > sheet.rowCount;
      const row = sheet.getRow(reading.rowNumber);
      if (isNewRow) {
        const previous = sheet.getRow(reading.rowNumber - 1);
        row.height = previous.height;
        for (let column = 1; column <= Math.max(sheet.columnCount, previous.cellCount); column++) {
          row.getCell(column).style = structuredClone(previous.getCell(column).style);
        }
      }
      writeReading(row, reading);
    }
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
