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
          checkSecretScanning: false,
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

describe('open secret scanning alert collection', () => {
  const retryConfig: RetryConfig = {
    maxAttempts: 1,
    initialDelayMs: 0,
    maxDelayMs: 0,
    backoffFactor: 1,
  };

  function repositoryPage() {
    return {
      data: [
        {
          node_id: 'R_1',
          name: 'one',
          full_name: 'acme/one',
          html_url: 'https://example.test/acme/one',
          description: null,
          created_at: null,
          updated_at: null,
          pushed_at: null,
          private: true,
          fork: false,
          custom_properties: {},
        },
        {
          node_id: 'R_2',
          name: 'two',
          full_name: 'acme/two',
          html_url: 'https://example.test/acme/two',
          description: null,
          created_at: null,
          updated_at: null,
          pushed_at: null,
          private: true,
          fork: false,
          custom_properties: {},
        },
      ],
    };
  }

  function setup(secretScanning: {
    listAlertsForOrg?: ReturnType<typeof vi.fn>;
    listAlertsForRepo?: ReturnType<typeof vi.fn>;
  }) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-secrets-'));
    temporaryDirectories.push(directory);
    const outputFile = path.join(directory, 'repositories.csv');
    const output = createCsvExport({
      outputFile,
      headers: [
        'repository_full_name',
        'has_open_secret_scan_alerts',
        'coverage_status',
        'collection_errors',
      ],
      force: false,
    });
    const octokit = {
      request: vi.fn().mockResolvedValue(repositoryPage()),
      graphql: vi.fn().mockResolvedValue({ nodes: [] }),
      rest: {
        secretScanning: {
          listAlertsForOrg: secretScanning.listAlertsForOrg ?? vi.fn(),
          listAlertsForRepo: secretScanning.listAlertsForRepo ?? vi.fn(),
        },
      },
    } as unknown as Octokit;

    return { outputFile, output, octokit };
  }

  function readRecords(outputFile: string): Record<string, string>[] {
    return parse(fs.readFileSync(outputFile, 'utf8'), {
      columns: true,
    }) as Record<string, string>[];
  }

  it('flags repositories from a single organization-wide alert pass', async () => {
    const listAlertsForOrg = vi.fn().mockResolvedValue({
      data: [{ repository: { full_name: 'acme/two' } }],
    });
    const { outputFile, output, octokit } = setup({ listAlertsForOrg });

    await processOrganization(
      {
        octokit,
        logger: logger(),
        retryConfig,
        retryDisabled: true,
        output,
        migrationStatusProperty: 'migration-status',
        migrationIssueProperty: 'migration-issue',
        baseUrl: 'https://api.example.test',
        checkSecretScanning: true,
      },
      'acme',
    );

    expect(listAlertsForOrg).toHaveBeenCalledOnce();
    expect(readRecords(outputFile)).toEqual([
      {
        repository_full_name: 'acme/one',
        has_open_secret_scan_alerts: 'false',
        coverage_status: 'complete',
        collection_errors: '',
      },
      {
        repository_full_name: 'acme/two',
        has_open_secret_scan_alerts: 'true',
        coverage_status: 'complete',
        collection_errors: '',
      },
    ]);
  });

  it('falls back to per-repository checks when the organization endpoint is unavailable', async () => {
    const listAlertsForOrg = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('forbidden'), { status: 403 }),
      );
    const listAlertsForRepo = vi
      .fn()
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [{ id: 1 }] });
    const { outputFile, output, octokit } = setup({
      listAlertsForOrg,
      listAlertsForRepo,
    });

    await processOrganization(
      {
        octokit,
        logger: logger(),
        retryConfig,
        retryDisabled: true,
        output,
        migrationStatusProperty: 'migration-status',
        migrationIssueProperty: 'migration-issue',
        baseUrl: 'https://api.example.test',
        checkSecretScanning: true,
      },
      'acme',
    );

    expect(listAlertsForOrg).toHaveBeenCalledOnce();
    expect(listAlertsForRepo).toHaveBeenCalledTimes(2);
    expect(
      readRecords(outputFile).map(
        (record) => record.has_open_secret_scan_alerts,
      ),
    ).toEqual(['false', 'true']);
  });

  it('records an unknown value and a partial row when a repository check fails', async () => {
    const listAlertsForOrg = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('forbidden'), { status: 403 }),
      );
    const listAlertsForRepo = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));
    const { outputFile, output, octokit } = setup({
      listAlertsForOrg,
      listAlertsForRepo,
    });

    const failures = await processOrganization(
      {
        octokit,
        logger: logger(),
        retryConfig,
        retryDisabled: true,
        output,
        migrationStatusProperty: 'migration-status',
        migrationIssueProperty: 'migration-issue',
        baseUrl: 'https://api.example.test',
        checkSecretScanning: true,
      },
      'acme',
    );

    expect(failures).toEqual([]);
    const records = readRecords(outputFile);
    expect(records[0].has_open_secret_scan_alerts).toBe('');
    expect(records[0].coverage_status).toBe('partial');
    expect(records[0].collection_errors).toContain('secret_scanning:');
  });

  it('skips all secret scanning requests when the check is disabled', async () => {
    const listAlertsForOrg = vi.fn();
    const listAlertsForRepo = vi.fn();
    const { outputFile, output, octokit } = setup({
      listAlertsForOrg,
      listAlertsForRepo,
    });

    await processOrganization(
      {
        octokit,
        logger: logger(),
        retryConfig,
        retryDisabled: true,
        output,
        migrationStatusProperty: 'migration-status',
        migrationIssueProperty: 'migration-issue',
        baseUrl: 'https://api.example.test',
        checkSecretScanning: false,
      },
      'acme',
    );

    expect(listAlertsForOrg).not.toHaveBeenCalled();
    expect(listAlertsForRepo).not.toHaveBeenCalled();
    expect(readRecords(outputFile)[0].has_open_secret_scan_alerts).toBe('');
  });
});
