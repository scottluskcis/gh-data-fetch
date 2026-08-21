import { Option } from 'commander';
import fs from 'fs';
import { validateOutputFile } from '../utils/csv.js';
import { parseRepositoryFile } from '../utils/github-input.js';
import {
  createCommandWithSharedOptions,
  parseBooleanOption,
} from './command-helpers.js';

const auditOrgReposCommand = createCommandWithSharedOptions('audit-org-repos')
  .description(
    'Validate repository audit inputs (audit execution is not implemented yet)',
  )
  .addOption(
    new Option(
      '--force [boolean]',
      'Allow validation against an existing output path',
    )
      .env('FORCE')
      .argParser(parseBooleanOption)
      .default(false),
  )
  .action(async (options) => {
    if (!options.repoList) {
      throw new Error('A repository list is required through --repo-list');
    }
    if (!options.outputFile) {
      throw new Error('An output path is required through --output-file');
    }

    parseRepositoryFile(fs.readFileSync(options.repoList, 'utf8'));
    validateOutputFile(options.outputFile, options.force);

    throw new Error(
      'audit-org-repos is not implemented yet; inputs were validated successfully',
    );
  });

export default auditOrgReposCommand;
