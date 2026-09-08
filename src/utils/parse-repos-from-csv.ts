import { parseCsvRecords } from './csv.js';

export interface RepoCsvColumns {
  repoColumn: string;
  orgColumn: string;
  delimiter: string;
}

/**
 * Reads a source CSV and returns one "org<delimiter>repo" value per row,
 * skipping rows that are missing either value.
 */
export function extractRepoLines(
  contents: string,
  columns: RepoCsvColumns,
): string[] {
  const records = parseCsvRecords(contents);
  if (records.length === 0) {
    return [];
  }

  const availableColumns = Object.keys(records[0]);
  for (const column of [columns.orgColumn, columns.repoColumn]) {
    if (!availableColumns.includes(column)) {
      throw new Error(
        `Column "${column}" was not found in the source CSV; available columns: ${availableColumns.join(', ')}`,
      );
    }
  }

  const lines: string[] = [];
  records.forEach((record, index) => {
    const org = record[columns.orgColumn]?.trim();
    const repo = record[columns.repoColumn]?.trim();
    if (!org || !repo) {
      console.warn(
        `Warning: skipping row ${index + 2} with a missing "${columns.orgColumn}" or "${columns.repoColumn}" value`,
      );
      return;
    }
    lines.push(`${org}${columns.delimiter}${repo}`);
  });

  return lines;
}

/**
 * Renders extracted "org<delimiter>repo" lines as CSV content, optionally
 * prefixed with a header row built from the source column names.
 */
export function renderRepoCsv(
  lines: string[],
  options: RepoCsvColumns & { includeHeader: boolean },
): string {
  const rows = options.includeHeader
    ? [
        `${options.orgColumn}${options.delimiter}${options.repoColumn}`,
        ...lines,
      ]
    : lines;
  return rows.length > 0 ? rows.join('\n') + '\n' : '';
}
