import { executeWithOctokit } from '@scottluskcis/octokit-harness';
import { Option } from 'commander';
import { createCommandWithSharedOptions } from './command-helpers.js';

const command = createCommandWithSharedOptions('command-name')
  .description('Describe what the command does')
  .addOption(
    new Option('--example <value>', 'Describe the command-specific input').env(
      'EXISTING_OR_NEW_SCHEMA_VARIABLE',
    ),
  )
  .action(async (options) => {
    await executeWithOctokit(options, async ({ octokit, logger, opts }) => {
      logger.info('Starting...');

      // Replace this example with the command's typed GitHub API workflow.
      await octokit.rest.repos.get({
        owner: opts.orgName,
        repo: options.example,
      });

      logger.info('Finished');
    });
  });

export default command;
