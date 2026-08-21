import type { Logger, RetryConfig } from '@scottluskcis/octokit-harness';
import { parse } from 'csv-parse/sync';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Octokit } from 'octokit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  customPropertyDisplayValue,
  isLockedForMigration,
  processOrganization,
} from '../../src/commands/list-org-repos.js';
import { createCsvExport } from '../../src/utils/csv.js';

const temporaryDirectories: string[] = [];

function logger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true });
  }
});

describe('repository inventory transformations', () => {
  it('identifies only migration locks', () => {
    expect(
      isLockedForMigration({ isLocked: true, lockReason: 'MIGRATING' }),
    ).toBe(true);
    expect(
      isLockedForMigration({ isLocked: true, lockReason: 'BILLING' }),
    ).toBe(false);
    expect(isLockedForMigration({ isLocked: false })).toBe(false);
    expect(isLockedForMigration(undefined)).toBeUndefined();
  });

  it('serializes non-scalar dedicated custom property values', () => {
    expect(customPropertyDisplayValue(['one', 'two'])).toBe('["one","two"]');
    expect(customPropertyDisplayValue('ready')).toBe('ready');
  });

  it('combines REST metadata, custom properties, and GraphQL lock state', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-command-'));
    temporaryDirectories.push(directory);
    const outputFile = path.join(directory, 'repositories.csv');
    const output = createCsvExport({
      outputFile,
      headers: [
        'repository_full_name',
        'migration_status',
        'custom_properties_json',
        'is_locked_for_migration',
      ],
      force: false,
    });
    const request = vi.fn().mockResolvedValue({
      data: [
        {
          node_id: 'R_1',
          name: 'one',
          full_name: 'acme/one',
          html_url: 'https://example.test/acme/one',
          description: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
          pushed_at: '2026-01-02T00:00:00Z',
          private: true,
          fork: false,
          custom_properties: {
            zebra: 'last',
            'migration-status': 'ready',
            alpha: ['one', 'two'],
          },
        },
      ],
    });
    const graphql = vi.fn().mockResolvedValue({
      nodes: [
        {
          id: 'R_1',
          nameWithOwner: 'acme/one',
          isLocked: true,
          lockReason: 'MIGRATING',
        },
      ],
    });
    const retryConfig: RetryConfig = {
      maxAttempts: 1,
      initialDelayMs: 0,
      maxDelayMs: 0,
      backoffFactor: 1,
    };

    await expect(
      processOrganization(
        {
          octokit: { request, graphql } as unknown as Octokit,
          logger: logger(),
          retryConfig,
          retryDisabled: true,
          output,
          migrationStatusProperty: 'migration-status',
          migrationIssueProperty: 'migration-issue',
          baseUrl: 'https://api.example.test',
        },
        'acme',
      ),
    ).resolves.toEqual([]);

    const records = parse(fs.readFileSync(outputFile, 'utf8'), {
      columns: true,
    }) as Record<string, string>[];
    expect(records).toEqual([
      {
        repository_full_name: 'acme/one',
        migration_status: 'ready',
        custom_properties_json:
          '{"alpha":["one","two"],"migration-status":"ready","zebra":"last"}',
        is_locked_for_migration: 'true',
      },
    ]);
    expect(request).toHaveBeenCalledOnce();
    expect(graphql).toHaveBeenCalledOnce();
  });
});
