import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';

/**
 * Parses CSV content with a header row into string-valued records.
 */
export function parseCsvRecords(contents: string): Record<string, string>[] {
  return parse(contents, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];
}

export type CsvPrimitive = string | number | boolean | null | undefined;

const ERROR_HEADERS = [
  'scope',
  'organization',
  'page_or_cursor',
  'operation',
  'message',
];

export interface CsvExport {
  outputFile: string;
  errorFile: string;
  append(record: Record<string, CsvPrimitive>): void;
  appendError(record: Record<string, CsvPrimitive>): void;
}

/**
 * Flattens a nested object into a single level object with dot notation keys
 * @param obj - The object to flatten
 * @param prefix - Prefix for the keys (used during recursion)
 * @returns Flattened object
 */
export function flattenObject(
  obj: Record<string, unknown>,
  prefix = '',
): Record<string, string | number | boolean | null> {
  const flattened: Record<string, string | number | boolean | null> = {};

  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const value = obj[key];
      const newKey = prefix ? `${prefix}_${key}` : key;

      if (value === null || value === undefined) {
        flattened[newKey] = null;
      } else if (typeof value === 'object' && !Array.isArray(value)) {
        // Recursively flatten nested objects
        Object.assign(
          flattened,
          flattenObject(value as Record<string, unknown>, newKey),
        );
      } else if (Array.isArray(value)) {
        // Convert arrays to JSON strings
        flattened[newKey] = JSON.stringify(value);
      } else {
        flattened[newKey] = value as string | number | boolean;
      }
    }
  }

  return flattened;
}

/**
 * Escapes a CSV field value
 */
export function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  const stringValue = String(value);

  // If the value contains comma, quote, or newline, wrap it in quotes and escape quotes
  if (
    stringValue.includes(',') ||
    stringValue.includes('"') ||
    stringValue.includes('\n')
  ) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

/**
 * Initializes CSV file with headers
 */
export function initializeCsvFile(filePath: string, headers: string[]): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const headerRow = headers.map(escapeCsvValue).join(',') + '\n';
  fs.writeFileSync(filePath, headerRow, 'utf8');
}

/**
 * Appends a record to the CSV file
 */
export function appendRecordToCsv(
  filePath: string,
  record: Record<string, unknown>,
  headers: string[],
): void {
  const flattened = flattenObject(record);

  // Create row with values in the same order as headers
  const row = headers.map((header) => escapeCsvValue(flattened[header]));

  // Append row to file
  fs.appendFileSync(filePath, row.join(',') + '\n', 'utf8');
}

export function validateOutputFile(outputFile: string, force: boolean): string {
  const resolved = path.resolve(outputFile);
  const errorFile = `${resolved}.errors.csv`;
  if (!force && (fs.existsSync(resolved) || fs.existsSync(errorFile))) {
    throw new Error(
      `Output already exists for ${resolved}; use --force to replace it`,
    );
  }
  return resolved;
}

export function createCsvExport(options: {
  outputFile: string;
  headers: string[];
  force: boolean;
}): CsvExport {
  const outputFile = validateOutputFile(options.outputFile, options.force);
  const errorFile = `${outputFile}.errors.csv`;
  initializeCsvFile(outputFile, options.headers);
  initializeCsvFile(errorFile, ERROR_HEADERS);

  return {
    outputFile,
    errorFile,
    append(record) {
      appendRecordToCsv(outputFile, record, options.headers);
    },
    appendError(record) {
      appendRecordToCsv(errorFile, record, ERROR_HEADERS);
    },
  };
}

/**
 * Extracts all unique headers from a sample record by flattening it
 */
export function extractHeaders(
  sampleRecord: Record<string, unknown>,
): string[] {
  const flattened = flattenObject(sampleRecord);
  return Object.keys(flattened).sort();
}
