import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import parseReposFromCsvCommand from '../../src/commands/parse-repos-from-csv.js';

const temporaryDirectories: string[] = [];

function tempDir(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'parse-repos-from-csv-'),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true });
  }
});

function writeFile(directory: string, name: string, contents: string): string {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, contents, 'utf8');
  return filePath;
}

async function runCommand(args: string[]): Promise<void> {
  await parseReposFromCsvCommand.parseAsync([
    'node',
    'parse-repos-from-csv',
    ...args,
  ]);
}

describe('parse-repos-from-csv command', () => {
  it('writes one org/repo value per line using the default delimiter and no header', async () => {
    const directory = tempDir();
    const sourceFile = writeFile(
      directory,
      'source.csv',
      [
        'repo_name,source_org,unrelated',
        'widgets,acme,x',
        'gadgets,acme,y',
      ].join('\n') + '\n',
    );
    const outputFile = path.join(directory, 'output.csv');

    await runCommand([
      '--input-file',
      sourceFile,
      '--org-column',
      'source_org',
      '--repo-column',
      'repo_name',
      '--output-file',
      outputFile,
    ]);

    expect(fs.readFileSync(outputFile, 'utf8')).toBe(
      'acme/widgets\nacme/gadgets\n',
    );
  });

  it('supports a custom delimiter and an optional header row', async () => {
    const directory = tempDir();
    const sourceFile = writeFile(
      directory,
      'source.csv',
      ['repo,org', 'widgets,acme'].join('\n') + '\n',
    );
    const outputFile = path.join(directory, 'output.csv');

    await runCommand([
      '--input-file',
      sourceFile,
      '--org-column',
      'org',
      '--repo-column',
      'repo',
      '--delimiter',
      '|',
      '--include-header',
      '--output-file',
      outputFile,
    ]);

    expect(fs.readFileSync(outputFile, 'utf8')).toBe(
      'org|repo\nacme|widgets\n',
    );
  });

  it('throws when the input file does not exist', async () => {
    const directory = tempDir();
    const outputFile = path.join(directory, 'output.csv');

    await expect(
      runCommand([
        '--input-file',
        path.join(directory, 'missing.csv'),
        '--org-column',
        'org',
        '--repo-column',
        'repo',
        '--output-file',
        outputFile,
      ]),
    ).rejects.toThrow(/Input file not found/);
  });

  it('throws when the output file already exists without --force', async () => {
    const directory = tempDir();
    const sourceFile = writeFile(
      directory,
      'source.csv',
      ['repo,org', 'widgets,acme'].join('\n') + '\n',
    );
    const outputFile = writeFile(directory, 'output.csv', 'existing');

    await expect(
      runCommand([
        '--input-file',
        sourceFile,
        '--org-column',
        'org',
        '--repo-column',
        'repo',
        '--output-file',
        outputFile,
      ]),
    ).rejects.toThrow(/Output already exists/);
  });
});
