import { createCommandWithSharedOptions } from './command-helpers.js';
import { getAuditLogActivity } from '../api/audit-log-events.js';
import { executeWithOctokit } from '@scottluskcis/octokit-harness';
import { Option } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import { initializeCsvFile, appendRecordToCsv } from '../utils/csv.js';
import { ensureDirectory, generateTimestampedFilename } from '../utils/file.js';

const checkOrgMembershipCommand = createCommandWithSharedOptions(
  'check-org-membership',
)
  .description(
    'Check organization membership for users from a CSV file and report current status and recent removals',
  )
  .addOption(
    new Option(
      '--input-csv <path>',
      'Path to CSV file containing user logins (must have a "login" column)',
    )
      .env('INPUT_CSV')
      .makeOptionMandatory(),
  )
  .addOption(
    new Option(
      '--lookback-days <days>',
      'Number of days to look back in audit logs for org removal events',
    )
      .env('LOOKBACK_DAYS')
      .default('7')
      .argParser((value: string) => {
        const parsed = parseInt(value, 10);
        if (isNaN(parsed) || parsed < 1 || parsed > 90) {
          throw new Error(
            'lookback-days must be a positive integer between 1 and 90',
          );
        }
        return parsed;
      }),
  )
  .action(async (options) => handleAction(options));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseArgs(options: any) {
  return {
    inputCsv: options.inputCsv,
    lookbackDays: options.lookbackDays,
    org: options.orgName,
    enterprise: options.enterpriseName,
    accessToken: options.accessToken,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleAction(options: any) {
  await executeWithOctokit(options, async ({ octokit, logger }) => {
    const opts = parseArgs(options);

    // Validate required options
    if (!opts.org) {
      logger.error('Organization name is required (--org-name or ORG_NAME)');
      return;
    }
    if (!opts.enterprise) {
      logger.error(
        'Enterprise name is required (--enterprise-name or ENTERPRISE_NAME)',
      );
      return;
    }

    logger.info('Starting organization membership check...');
    logger.info(`Organization: ${opts.org}`);
    logger.info(`Enterprise: ${opts.enterprise}`);
    logger.info(`Input CSV: ${opts.inputCsv}`);
    logger.info(`Lookback days: ${opts.lookbackDays}`);
    logger.info(
      `Authentication: ${opts.accessToken ? 'Token provided' : 'No token found'}`,
    );

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

    // Validate CSV has login column
    if (records.length > 0 && !records[0].hasOwnProperty('login')) {
      logger.error(
        'CSV file must have a "login" column. Found columns: ' +
          Object.keys(records[0]).join(', '),
      );
      return;
    }

    // Extract and deduplicate usernames
    const usernamesSet = new Set<string>();
    for (const record of records) {
      if (record.login && record.login.trim()) {
        usernamesSet.add(record.login.trim());
      }
    }

    const usernames = Array.from(usernamesSet);
    logger.info(`Processing ${usernames.length} unique users`);

    if (usernames.length === 0) {
      logger.info('No users to process after filtering');
      return;
    }

    // Calculate lookback date
    const lookbackDate = new Date(
      Date.now() - opts.lookbackDays * 24 * 60 * 60 * 1000,
    );
    const lookbackDateIso = lookbackDate.toISOString();
    logger.info(
      `Checking audit logs for removals since: ${lookbackDateIso.split('T')[0]}`,
    );

    // Track recent org removals from audit logs
    const recentRemovals = new Map<
      string,
      { removed_at: string; actor: string; timestamp: number }
    >();

    logger.info('Fetching organization removal events from audit logs...');
    logger.info(
      `Query parameters: enterprise=${opts.enterprise}, action=org.remove_member, created=>=${lookbackDateIso}`,
    );

    // First, test if we can access the audit log at all
    logger.info('Testing audit log access...');
    try {
      const testIterator = getAuditLogActivity({
        octokit: octokit,
        enterpriseName: opts.enterprise,
        type: 'enterprise',
      });

      let testCount = 0;
      for await (const event of testIterator) {
        testCount++;
        if (testCount === 1) {
          logger.info(
            `✓ Audit log access confirmed. Sample event action: ${event.action}`,
          );
        }
        if (testCount >= 5) break; // Just check first 5 events
      }

      if (testCount === 0) {
        logger.warn(
          '⚠ No audit log events returned at all. Check enterprise name and token permissions.',
        );
      } else {
        logger.info(`Found ${testCount} recent audit log events (any action)`);
      }
    } catch (testError) {
      logger.error(`✗ Cannot access audit log: ${testError}`);
    }

    logger.info('Now searching for org.remove_member events...');
    try {
      const removalIterator = getAuditLogActivity({
        octokit: octokit,
        enterpriseName: opts.enterprise,
        action: 'org.remove_member',
        created: `>=${lookbackDateIso}`,
        type: 'enterprise',
      });

      let removalCount = 0;
      let totalRemovalEvents = 0;
      let iteratorCalled = false;
      for await (const event of removalIterator) {
        if (!iteratorCalled) {
          logger.info('Audit log iterator started returning events...');
          iteratorCalled = true;
        }
        totalRemovalEvents++;

        // Log first few events for debugging
        if (totalRemovalEvents <= 10) {
          logger.info(
            `Sample removal event #${totalRemovalEvents}: user=${event.props.user}, org=${event.props.org}, actor=${event.actor}, date=${event.date.toISOString()}`,
          );
        }

        // Filter to only the specific org we're checking (case-insensitive)
        const eventOrg = event.props.org?.toLowerCase();
        const targetOrg = opts.org?.toLowerCase();
        if (eventOrg !== targetOrg) {
          if (totalRemovalEvents <= 10) {
            logger.info(
              `  → Skipping: org '${event.props.org}' doesn't match target '${opts.org}'`,
            );
          }
          continue;
        }

        logger.info(`  ✓ Org matches! Processing user: ${event.props.user}`);

        const user = event.props.user;
        // Only track users from our input list
        if (!usernamesSet.has(user)) {
          continue;
        }

        const timestamp = event.props.created_at || event.date.getTime();
        const existing = recentRemovals.get(user);

        // Keep only the most recent removal per user
        if (!existing || timestamp > existing.timestamp) {
          recentRemovals.set(user, {
            removed_at: event.date.toISOString(),
            actor: event.actor,
            timestamp: timestamp,
          });
          removalCount++;
        }
      }
      if (!iteratorCalled) {
        logger.warn(
          'Audit log iterator returned no events. This could mean: 1) No removal events in the time period, 2) Missing enterprise access, or 3) Incorrect enterprise name',
        );
      }
      logger.info(`Total removal events found: ${totalRemovalEvents}`);
      logger.info(
        `Found ${recentRemovals.size} users from input list with recent org removal events`,
      );
    } catch (error) {
      logger.error(`Error fetching audit logs: ${error}`);
      logger.info('Continuing without audit log data...');
    }

    // Set up output directory and file path
    const outputDir = path.join(process.cwd(), 'output');
    ensureDirectory(outputDir);

    const baseFilename = `org-membership-check-${opts.org}`;
    const filename = generateTimestampedFilename(baseFilename, 'csv');
    const csvFilePath = path.join(outputDir, filename);

    const headers = [
      'username',
      'is_current_member',
      'role',
      'state',
      'was_removed_recently',
      'removed_at',
      'removed_by_actor',
    ];

    initializeCsvFile(csvFilePath, headers);
    logger.info(`Output CSV: ${csvFilePath}`);

    // Initialize counters
    let totalChecked = 0;
    let currentMembers = 0;
    let notMembers = 0;
    let errors = 0;
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 5;
    const recentlyRemovedCount = recentRemovals.size;

    // Check current membership for each user
    logger.info('Checking current organization membership...');
    for (let i = 0; i < usernames.length; i++) {
      const username = usernames[i];
      totalChecked++;

      // Log progress every 10 users
      if ((i + 1) % 10 === 0 || i === 0 || i === usernames.length - 1) {
        logger.info(`Checking user ${i + 1} of ${usernames.length}...`);
      }

      let isMember = false;
      let role = '';
      let state = '';
      let errorMessage = '';

      try {
        logger.debug(
          `Checking membership for ${username} in org ${opts.org}...`,
        );
        const response = await octokit.rest.orgs.getMembershipForUser({
          org: opts.org,
          username: username,
        });

        isMember = true;
        role = response.data.role || '';
        state = response.data.state || '';
        currentMembers++;
        consecutiveErrors = 0; // Reset consecutive error count on success
      } catch (error: any) {
        if (error.status === 404) {
          // User is not a member
          isMember = false;
          notMembers++;
          consecutiveErrors = 0; // Reset consecutive error count on 404
          logger.debug(`User ${username} is not a member (404)`);
        } else {
          // Other error
          errorMessage = error.message || 'Unknown error';
          logger.warn(
            `Error checking membership for ${username}: ${errorMessage} (status: ${error.status || 'unknown'})`,
          );
          errors++;
          consecutiveErrors++;

          // Stop processing if we hit too many consecutive errors
          if (consecutiveErrors >= maxConsecutiveErrors) {
            logger.error(
              `\nStopping: encountered ${consecutiveErrors} consecutive API errors. This may indicate authentication issues or rate limiting.`,
            );
            logger.error(
              `Processed ${totalChecked} of ${usernames.length} users before stopping.`,
            );
            break;
          }
        }
      }

      // Check if user was recently removed
      const removalInfo = recentRemovals.get(username);
      const wasRemovedRecently = removalInfo !== undefined;
      const removedAt = removalInfo?.removed_at || '';
      const removedByActor = removalInfo?.actor || '';

      // Write to CSV
      appendRecordToCsv(
        csvFilePath,
        {
          username: username,
          is_current_member: errorMessage
            ? 'error'
            : isMember
              ? 'true'
              : 'false',
          role: role,
          state: state,
          was_removed_recently: wasRemovedRecently ? 'true' : 'false',
          removed_at: removedAt,
          removed_by_actor: removedByActor,
        },
        headers,
      );
    }

    // Log summary
    logger.info('\n=== Summary ===');
    logger.info(`Total users checked: ${totalChecked}`);
    logger.info(`Current members: ${currentMembers}`);
    logger.info(`Not current members: ${notMembers}`);
    logger.info(
      `Recently removed from org (within ${opts.lookbackDays} days): ${recentlyRemovedCount}`,
    );
    logger.info(`API errors encountered: ${errors}`);
    logger.info(`\nOutput CSV file: ${csvFilePath}`);
  });
}

export default checkOrgMembershipCommand;
