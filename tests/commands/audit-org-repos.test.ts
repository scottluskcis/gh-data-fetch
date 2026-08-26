import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import auditOrgReposCommand from '../../src/commands/audit-org-repos.js';

const temporaryDirectories: string[] = [];

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-org-repos-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true });
  }
});

const SOURCE_HEADERS =
  'organization_login,repository_name,repository_url,migration_status,migration_issue,is_locked';
const TARGET_HEADERS =
  'organization_login,repository_name,repository_url,visibility,archived,created_at,migration_issue';

function writeFile(directory: string, name: string, contents: string): string {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, contents, 'utf8');
  return filePath;
}

async function runCommand(args: string[]): Promise<void> {
  // A fresh Command clone isn't needed here: commander's action does not
  // mutate global state, and each test uses a distinct temp directory.
  await auditOrgReposCommand.parseAsync(['node', 'audit-org-repos', ...args]);
}

describe('audit-org-repos command', () => {
  it('writes a combined CSV and Markdown report', async () => {
    const directory = tempDir();
    const sourceFile = writeFile(
      directory,
      'source.csv',
      [
        SOURCE_HEADERS,
        'acme,one,https://github.com/acme/one,success,123,true',
        'acme,two,https://github.com/acme/two,not-started,,false',
      ].join('\n') + '\n',
    );
    const softwareFile = writeFile(
      directory,
      'software.csv',
      [
        TARGET_HEADERS,
        'acme-software,one,https://github.com/acme-software/one,private,false,2024-01-01T00:00:00Z,123',
      ].join('\n') + '\n',
    );
    const outputFile = path.join(directory, 'audit.csv');

    await runCommand([
      '--repo-list',
      sourceFile,
      '--target-repo-list',
      `software=${softwareFile}`,
      '--output-file',
      outputFile,
    ]);

    const csvContent = fs.readFileSync(outputFile, 'utf8');
    expect(csvContent).toContain('one,acme');
    expect(csvContent).toContain('acme-software');

    const markdownFile = path.join(directory, 'audit.md');
    expect(fs.existsSync(markdownFile)).toBe(true);
    expect(fs.readFileSync(markdownFile, 'utf8')).toContain('## Summary');
  });

  it('rejects a target export that resolves to the same file as the source', async () => {
    const directory = tempDir();
    const sourceFile = writeFile(
      directory,
      'source.csv',
      `${SOURCE_HEADERS}\nacme,one,https://github.com/acme/one,success,123,true\n`,
    );

    await expect(
      runCommand([
        '--repo-list',
        sourceFile,
        '--target-repo-list',
        `software=${sourceFile}`,
        '--output-file',
        path.join(directory, 'audit.csv'),
      ]),
    ).rejects.toThrow('cannot be the source export');
  });

  it('rejects a target export with the same organization as the source', async () => {
    const directory = tempDir();
    const sourceFile = writeFile(
      directory,
      'source.csv',
      `${SOURCE_HEADERS}\nacme,one,https://github.com/acme/one,success,123,true\n`,
    );
    const softwareFile = writeFile(
      directory,
      'software.csv',
      `${TARGET_HEADERS}\nacme,one,https://github.com/acme/one,private,false,2024-01-01T00:00:00Z,123\n`,
    );

    await expect(
      runCommand([
        '--repo-list',
        sourceFile,
        '--target-repo-list',
        `software=${softwareFile}`,
        '--output-file',
        path.join(directory, 'audit.csv'),
      ]),
    ).rejects.toThrow('cannot be the source organization');
  });

  it('requires --archive-suffix when an archive target is supplied', async () => {
    const directory = tempDir();
    const sourceFile = writeFile(
      directory,
      'source.csv',
      `${SOURCE_HEADERS}\nacme,one,https://github.com/acme/one,success,123,true\n`,
    );
    const archiveFile = writeFile(
      directory,
      'archive.csv',
      `${TARGET_HEADERS}\nacme-archive,one-dova,https://github.com/acme-archive/one-dova,private,true,2024-01-01T00:00:00Z,\n`,
    );

    await expect(
      runCommand([
        '--repo-list',
        sourceFile,
        '--target-repo-list',
        `archive=${archiveFile}`,
        '--output-file',
        path.join(directory, 'audit.csv'),
      ]),
    ).rejects.toThrow('--archive-suffix is required');
  });

  it('rejects an --output-file that would collide with its own derived Markdown path', async () => {
    const directory = tempDir();
    const sourceFile = writeFile(
      directory,
      'source.csv',
      `${SOURCE_HEADERS}\nacme,one,https://github.com/acme/one,success,123,true\n`,
    );
    const softwareFile = writeFile(
      directory,
      'software.csv',
      `${TARGET_HEADERS}\nacme-software,one,https://github.com/acme-software/one,private,false,2024-01-01T00:00:00Z,123\n`,
    );

    await expect(
      runCommand([
        '--repo-list',
        sourceFile,
        '--target-repo-list',
        `software=${softwareFile}`,
        '--output-file',
        path.join(directory, 'audit.md'),
      ]),
    ).rejects.toThrow('distinct Markdown report path');
  });

  it('rejects an existing output file unless --force is set', async () => {
    const directory = tempDir();
    const sourceFile = writeFile(
      directory,
      'source.csv',
      `${SOURCE_HEADERS}\nacme,one,https://github.com/acme/one,success,123,true\n`,
    );
    const softwareFile = writeFile(
      directory,
      'software.csv',
      `${TARGET_HEADERS}\nacme-software,one,https://github.com/acme-software/one,private,false,2024-01-01T00:00:00Z,123\n`,
    );
    const outputFile = writeFile(directory, 'audit.csv', 'existing');

    await expect(
      runCommand([
        '--repo-list',
        sourceFile,
        '--target-repo-list',
        `software=${softwareFile}`,
        '--output-file',
        outputFile,
      ]),
    ).rejects.toThrow('already exists');
  });
});
