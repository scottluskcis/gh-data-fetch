import { createCommandWithSharedOptions } from './command-helpers.js';
import { executeWithOctokit } from '@scottluskcis/octokit-harness';
import { Option } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import { initializeCsvFile, appendRecordToCsv } from '../utils/csv.js';
import { ensureDirectory, generateTimestampedFilename } from '../utils/file.js';

const restoreRemovedUsersCommand = createCommandWithSharedOptions(
  'restore-removed-users',
)
  .description('Restore removed users to repositories from CSV file')
  .addOption(
    new Option(
      '--input-csv <path>',
      'Path to CSV file containing removed users data',
    )
      .env('INPUT_CSV')
      .makeOptionMandatory(),
  )
  .addOption(
    new Option(
      '--dry-run [value]',
      'Preview actions without making any changes (true/false)',
    )
      .env('DRY_RUN')
      .default(false),
  )
  .addOption(
    new Option(
      '--repo <repository>',
      'Filter to process only this specific repository',
    ).env('REPO'),
  )
  .action(async (options) => handleAction(options));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseArgs(options: any) {
  // Parse dryRun - handle both boolean and string "false"/"true" from env vars
  let dryRun = false;
  if (options.dryRun !== undefined) {
    if (typeof options.dryRun === 'boolean') {
      dryRun = options.dryRun;
    } else if (typeof options.dryRun === 'string') {
      dryRun = options.dryRun.toLowerCase() === 'true';
    }
  }

  return {
    inputCsv: options.inputCsv,
    dryRun: dryRun,
    repoFilter: options.repo,
  };
}

function isValidPermission(permission: string | null | undefined): boolean {
  if (!permission) return false;
  const validPermissions = [
    'pull',
    'push',
    'admin',
    'maintain',
    'triage',
    'read',
    'write',
  ];
  return validPermissions.includes(permission.toLowerCase());
}

function mapPermissionToApi(permission: string): string {
  // Audit log uses 'read' and 'write', but the API expects 'pull' and 'push'
  const permissionMap: Record<string, string> = {
    read: 'pull',
    write: 'push',
  };
  return permissionMap[permission.toLowerCase()] || permission.toLowerCase();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleAction(options: any) {
  await executeWithOctokit(options, async ({ octokit, logger }) => {
    const opts = parseArgs(options);

    logger.info('Starting restore removed users process...');
    logger.info(`Input CSV: ${opts.inputCsv}`);
    logger.info(`Dry run mode: ${opts.dryRun}`);

    if (opts.repoFilter) {
      logger.info(`Filtering by repository: ${opts.repoFilter}`);
    }

    // Read and parse CSV file
    let records: any[] = [];
    try {
      const fileContent = fs.readFileSync(opts.inputCsv, 'utf-8');
      records = parse(fileContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });
      logger.info(`Read ${records.length} records from CSV`);
    } catch (error) {
      logger.error(`Error reading CSV file: ${error}`);
      return;
    }

    // Apply filters if provided
    if (opts.repoFilter) {
      records = records.filter((record) => record.repo === opts.repoFilter);
      logger.info(
        `Filtered to ${records.length} records for repo: ${opts.repoFilter}`,
      );
    }

    if (records.length === 0) {
      logger.info('No records to process after filtering');
      return;
    }

    // Set up output directory and file path
    const outputDir = path.join(process.cwd(), 'output');
    ensureDirectory(outputDir);

    const baseFilename = 'restore-removed-users-status';
    const filename = generateTimestampedFilename(baseFilename, 'csv');
    const csvFilePath = path.join(outputDir, filename);

    const headers = [
      'user',
      'repo',
      'requested_permission',
      'current_permission',
      'status',
      'message',
    ];

    initializeCsvFile(csvFilePath, headers);
    logger.info(`Output CSV: ${csvFilePath}`);

    // Initialize counters
    let totalProcessed = 0;
    let added = 0;
    let alreadyExists = 0;
    let permissionDifferent = 0;
    let errors = 0;
    let skipped = 0;

    // Process each record
    for (const record of records) {
      const user = record.user;
      const repoFullName = record.repo;
      const origPermission = record.orig_permission;

      totalProcessed++;

      // Validate permission
      if (!isValidPermission(origPermission)) {
        const permissionDisplay = origPermission || 'empty/null';
        logger.warn(
          `Skipping ${user} in ${repoFullName}: Invalid or missing permission '${permissionDisplay}'`,
        );
        appendRecordToCsv(
          csvFilePath,
          {
            user,
            repo: repoFullName,
            requested_permission: origPermission || 'N/A',
            current_permission: 'N/A',
            status: 'skipped_invalid_permission',
            message: origPermission
              ? `Invalid permission value: ${origPermission}`
              : 'No original permission found - cannot restore without knowing permission level',
          },
          headers,
        );
        skipped++;
        continue;
      }

      // Parse repository name
      let owner: string;
      let repoName: string;
      try {
        const parts = repoFullName.split('/');
        if (parts.length !== 2) {
          throw new Error('Invalid repository format');
        }
        [owner, repoName] = parts;
      } catch (error) {
        logger.error(
          `Skipping ${user} in ${repoFullName}: Malformed repository name`,
        );
        appendRecordToCsv(
          csvFilePath,
          {
            user,
            repo: repoFullName,
            requested_permission: origPermission,
            current_permission: 'N/A',
            status: 'error',
            message: 'Malformed repository name',
          },
          headers,
        );
        errors++;
        continue;
      }

      // Check if user is already a direct collaborator
      let isDirectCollaborator = false;
      let currentPermission: string | null = null;

      try {
        logger.info(
          `Checking if ${user} is a direct collaborator on ${repoFullName}...`,
        );

        // First check if they are a direct collaborator (not through team)
        await octokit.rest.repos.checkCollaborator({
          owner,
          repo: repoName,
          username: user,
        });

        // If we get here (no 404), they are a direct collaborator
        isDirectCollaborator = true;

        // Now get their permission level
        const response =
          await octokit.rest.repos.getCollaboratorPermissionLevel({
            owner,
            repo: repoName,
            username: user,
          });

        currentPermission = response.data.permission;
        logger.info(
          `User ${user} is a direct collaborator with ${currentPermission} permission on ${repoFullName}`,
        );

        if (currentPermission === origPermission) {
          appendRecordToCsv(
            csvFilePath,
            {
              user,
              repo: repoFullName,
              requested_permission: origPermission,
              current_permission: currentPermission,
              status: 'already_exists_same',
              message: `User already has ${currentPermission} direct permission`,
            },
            headers,
          );
          alreadyExists++;
        } else {
          appendRecordToCsv(
            csvFilePath,
            {
              user,
              repo: repoFullName,
              requested_permission: origPermission,
              current_permission: currentPermission,
              status: 'already_exists_different',
              message: `User has ${currentPermission} direct permission, requested was ${origPermission}`,
            },
            headers,
          );
          alreadyExists++;
          permissionDifferent++;
        }
      } catch (error: any) {
        // User is not a direct collaborator (404) or other error
        if (error.status === 404) {
          // User is not a direct collaborator, add them
          if (opts.dryRun) {
            const apiPermission = mapPermissionToApi(origPermission);
            logger.info(
              `[DRY RUN] Would add ${user} to ${repoFullName} with ${apiPermission} permission`,
            );
            appendRecordToCsv(
              csvFilePath,
              {
                user,
                repo: repoFullName,
                requested_permission: origPermission,
                current_permission: 'N/A',
                status: 'dry_run_would_add',
                message: `Would add user with ${origPermission} permission`,
              },
              headers,
            );
          } else {
            try {
              const apiPermission = mapPermissionToApi(origPermission);
              logger.info(
                `Adding ${user} to ${repoFullName} with ${apiPermission} permission...`,
              );
              await octokit.rest.repos.addCollaborator({
                owner,
                repo: repoName,
                username: user,
                permission: apiPermission,
              });
              logger.info(
                `Successfully added ${user} to ${repoFullName} with ${apiPermission} permission`,
              );
              appendRecordToCsv(
                csvFilePath,
                {
                  user,
                  repo: repoFullName,
                  requested_permission: origPermission,
                  current_permission: 'N/A',
                  status: 'added',
                  message: `Successfully added with ${origPermission} permission`,
                },
                headers,
              );
              added++;
            } catch (addError: any) {
              logger.error(
                `Error adding ${user} to ${repoFullName}: ${addError.message}`,
              );
              appendRecordToCsv(
                csvFilePath,
                {
                  user,
                  repo: repoFullName,
                  requested_permission: origPermission,
                  current_permission: 'N/A',
                  status: 'error',
                  message: `Error adding user: ${addError.message}`,
                },
                headers,
              );
              errors++;
            }
          }
        } else {
          // Other error
          logger.error(
            `Error checking ${user} on ${repoFullName}: ${error.message}`,
          );
          appendRecordToCsv(
            csvFilePath,
            {
              user,
              repo: repoFullName,
              requested_permission: origPermission,
              current_permission: 'N/A',
              status: 'error',
              message: `Error checking collaborator: ${error.message}`,
            },
            headers,
          );
          errors++;
        }
      }
    }

    // Log summary
    logger.info('\n=== Summary ===');
    logger.info(`Total records processed: ${totalProcessed}`);
    logger.info(`Added: ${added}`);
    logger.info(`Already exists: ${alreadyExists}`);
    logger.info(`  - With different permission: ${permissionDifferent}`);
    logger.info(`Skipped (invalid permission): ${skipped}`);
    logger.info(`Errors: ${errors}`);
    logger.info(`\nStatus report written to: ${csvFilePath}`);
  });
}

export default restoreRemovedUsersCommand;
