import { Command, Option } from 'commander';

// Helper functions for parsing
export function parseIntOption(value: string): number {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Invalid integer value: ${value}`);
  }
  return parsed;
}

export function parseFloatOption(value: string): number {
  const parsed = parseFloat(value);
  if (isNaN(parsed)) {
    throw new Error(`Invalid float value: ${value}`);
  }
  return parsed;
}

export function parseRepoListOption(
  value: string,
): { owner: string; repo: string }[] {
  return value.split(',').map((fullName) => {
    const [owner, repo] = fullName.split('/');
    return { owner, repo };
  });
}

export function withSharedOptions(cmd: Command): Command {
  return (
    cmd
      // Organization and authentication options
      .addOption(
        new Option(
          '-o, --org-name <org>',
          'The name of the organization to process',
        ).env('ORG_NAME'),
      )
      .addOption(
        new Option('-t, --access-token <token>', 'GitHub access token').env(
          'ACCESS_TOKEN',
        ),
      )
      .addOption(
        new Option('-u, --base-url <url>', 'GitHub API base URL')
          .env('BASE_URL')
          .default('https://api.github.com'),
      )
      .addOption(
        new Option('--proxy-url <url>', 'Proxy URL if required').env(
          'PROXY_URL',
        ),
      )
      .addOption(
        new Option('-v, --verbose', 'Enable verbose logging').env('VERBOSE'),
      )
      // GitHub App authentication options
      .addOption(new Option('--app-id <id>', 'GitHub App ID').env('APP_ID'))
      .addOption(
        new Option('--private-key <key>', 'GitHub App private key').env(
          'PRIVATE_KEY',
        ),
      )
      .addOption(
        new Option(
          '--private-key-file <file>',
          'Path to GitHub App private key file',
        ).env('PRIVATE_KEY_FILE'),
      )
      .addOption(
        new Option(
          '--app-installation-id <id>',
          'GitHub App installation ID',
        ).env('APP_INSTALLATION_ID'),
      )
      // Pagination options
      .addOption(
        new Option('--page <page>', 'Page to start from')
          .env('PAGE')
          .default('1')
          .argParser(parseIntOption),
      )
      .addOption(
        new Option('--page-size <size>', 'Number of items per page')
          .env('PAGE_SIZE')
          .default('10')
          .argParser(parseIntOption),
      )
      .addOption(
        new Option('--extra-page-size <size>', 'Extra page size')
          .env('EXTRA_PAGE_SIZE')
          .default('50')
          .argParser(parseIntOption),
      )
      // Rate limiting options
      .addOption(
        new Option(
          '--rate-limit-check-interval <seconds>',
          'Interval for rate limit checks in seconds',
        )
          .env('RATE_LIMIT_CHECK_INTERVAL')
          .default('25')
          .argParser(parseIntOption),
      )
      // Retry mechanism options
      .addOption(
        new Option(
          '--retry-max-attempts <attempts>',
          'Maximum number of retry attempts',
        )
          .env('RETRY_MAX_ATTEMPTS')
          .default('3')
          .argParser(parseIntOption),
      )
      .addOption(
        new Option(
          '--retry-initial-delay <milliseconds>',
          'Initial delay for retry in milliseconds',
        )
          .env('RETRY_INITIAL_DELAY')
          .default('1000')
          .argParser(parseIntOption),
      )
      .addOption(
        new Option(
          '--retry-max-delay <milliseconds>',
          'Maximum delay for retry in milliseconds',
        )
          .env('RETRY_MAX_DELAY')
          .default('30000')
          .argParser(parseIntOption),
      )
      .addOption(
        new Option(
          '--retry-backoff-factor <factor>',
          'Backoff factor for retry delays',
        )
          .env('RETRY_BACKOFF_FACTOR')
          .default('2')
          .argParser(parseFloatOption),
      )
      .addOption(
        new Option(
          '--retry-success-threshold <count>',
          'Number of successful operations before resetting retry count',
        )
          .env('RETRY_SUCCESS_THRESHOLD')
          .default('5')
          .argParser(parseIntOption),
      )
      .addOption(
        new Option(
          '--retry-disabled',
          'Disable retry mechanism completely',
        ).env('RETRY_DISABLED'),
      )
      // Processing options
      .addOption(
        new Option(
          '--resume-from-last-save',
          'Resume from the last saved state',
        ).env('RESUME_FROM_LAST_SAVE'),
      )
      .addOption(
        new Option('--output-file <file>', 'Path to file for output data').env(
          'OUTPUT_FILE',
        ),
      )
      .addOption(
        new Option(
          '-f, --output-file-name <file>',
          'Name of the output file',
        ).env('OUTPUT_FILE_NAME'),
      )
      .addOption(
        new Option(
          '--repo-list <file>',
          'Path to file containing list of repositories to process (format: owner/repo_name)',
        ).env('REPO_LIST'),
      )
      .addOption(
        new Option(
          '--auto-process-missing',
          'Automatically process any missing repositories when main processing is complete',
        ).env('AUTO_PROCESS_MISSING'),
      )
  );
}

export function createCommandWithSharedOptions(
  name: string | undefined,
): Command {
  const cmd = new Command(name);
  return withSharedOptions(cmd);
}
