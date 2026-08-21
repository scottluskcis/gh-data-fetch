import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCsvExport,
  parseCsvRecords,
  validateOutputFile,
} from '../../src/utils/csv.js';

const temporaryDirectories: string[] = [];

function temporaryOutput(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-export-test-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'output.csv');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true });
  }
});

describe('parseCsvRecords', () => {
  it('parses headers, quoted values, whitespace, and a byte order mark', () => {
    expect(
      parseCsvRecords(
        '\uFEFForganization_login,description\n acme ,"Example, Inc."\n',
      ),
    ).toEqual([
      {
        organization_login: 'acme',
        description: 'Example, Inc.',
      },
    ]);
  });

  it('skips empty lines', () => {
    expect(parseCsvRecords('name\n\nalpha\n\nbeta\n')).toEqual([
      { name: 'alpha' },
      { name: 'beta' },
    ]);
  });
});

describe('CSV export', () => {
  it('writes records and error sidecars', () => {
    const outputFile = temporaryOutput();
    const output = createCsvExport({
      outputFile,
      headers: ['organization', 'repository'],
      force: false,
    });
    output.append({ organization: 'acme', repository: 'one' });
    output.appendError({
      scope: 'page',
      organization: 'acme',
      page_or_cursor: 2,
      operation: 'locks',
      message: 'unavailable',
    });

    expect(fs.readFileSync(outputFile, 'utf8')).toBe(
      'organization,repository\nacme,one\n',
    );
    expect(fs.readFileSync(`${outputFile}.errors.csv`, 'utf8')).toContain(
      'page,acme,2,locks,unavailable',
    );
  });

  it('rejects existing output unless force is enabled', () => {
    const outputFile = temporaryOutput();
    fs.writeFileSync(outputFile, 'existing');
    expect(() => validateOutputFile(outputFile, false)).toThrow(
      'already exists',
    );
    expect(validateOutputFile(outputFile, true)).toBe(outputFile);
  });
});
