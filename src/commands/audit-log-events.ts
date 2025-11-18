import {
  createCommandWithSharedOptions,
  parseRepoListOption,
} from '../commands/command-helpers.js';

import { executeWithOctokit } from '@scottluskcis/octokit-harness';
import { Option } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import {
  initializeCsvFile,
  appendRecordToCsv,
  extractHeaders,
} from '../utils/csv.js';
import { ensureDirectory, generateTimestampedFilename } from '../utils/file.js';

const listAuditLogEventsCommand = createCommandWithSharedOptions(
  'list-audit-log-events',
)
  .description('List audit log events for the specified organization')

  .action(async (options) => handleAction(options));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseArgs(options: any) {
  return {};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleAction(options: any) {
  await executeWithOctokit(options, async ({ octokit, logger }) => {
    const opts = {
      octokit,
      ...parseArgs(options),
    };
    logger.info('Fetching audit log events...');
  });
}

export default listAuditLogEventsCommand;
