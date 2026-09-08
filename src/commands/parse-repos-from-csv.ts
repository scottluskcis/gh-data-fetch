import { Command, Option } from 'commander';
import fs from 'fs';
import path from 'path';
import { ensureOutputPathWritable } from '../utils/csv.js';
import {
  extractRepoLines,
  renderRepoCsv,
} from '../utils/parse-repos-from-csv.js';
import { parseBooleanOption } from './command-helpers.js';

/**
 * `parse-repos-from-csv` is a pure local file transform: it never talks to
 * the GitHub API, so unlike most other commands it does not build on
 * `createCommandWithSharedOptions` (which adds auth, pagination, retry, and
 * other API-oriented options that would not apply here).
 */
const parseReposFromCsvCommand = new Command('parse-repos-from-csv')
  .description(
    'Extract organization and repository name columns from a source CSV into a new CSV containing one "org<delimiter>repo" value per line',
  )
  .addOption(
    new Option('--input-file <file>', 'Path to the source CSV file')
      .env('INPUT_FILE')
      .makeOptionMandatory(),
  )
  .addOption(
    new Option(
      '--org-column <name>',
      'Name of the source CSV column containing the organization name',
    )
      .env('ORG_COLUMN')
      .makeOptionMandatory(),
  )
  .addOption(
    new Option(
      '--repo-column <name>',
      'Name of the source CSV column containing the repository name',
    )
      .env('REPO_COLUMN')
      .makeOptionMandatory(),
  )
  .addOption(
    new Option(
      '--delimiter <char>',
      'Delimiter placed between the organization and repository name in the output',
    )
      .env('DELIMITER')
      .default('/'),
  )
  .addOption(
    new Option(
      '--include-header [boolean]',
      'Include a header row (built from the source column names) in the output CSV',
    )
      .env('INCLUDE_HEADER')
      .argParser(parseBooleanOption)
      .default(false),
  )
  .addOption(
    new Option('--output-file <file>', 'Path to write the output CSV')
      .env('OUTPUT_FILE')
      .makeOptionMandatory(),
  )
  .addOption(
    new Option('--force [boolean]', 'Replace an existing output file')
      .env('FORCE')
      .argParser(parseBooleanOption)
      .default(false),
  )
  .action(async (options) => {
    const inputPath = path.resolve(options.inputFile);
    if (!fs.existsSync(inputPath)) {
      throw new Error(`Input file not found: ${inputPath}`);
    }

    // Validate the output path before parsing/writing anything.
    const outputPath = ensureOutputPathWritable(
      options.outputFile,
      options.force,
    );

    const columns = {
      orgColumn: options.orgColumn,
      repoColumn: options.repoColumn,
      delimiter: options.delimiter,
    };

    const lines = extractRepoLines(fs.readFileSync(inputPath, 'utf8'), columns);

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(
      outputPath,
      renderRepoCsv(lines, {
        ...columns,
        includeHeader: options.includeHeader,
      }),
      'utf8',
    );

    console.log(
      `Parsed ${lines.length} repositories from ${inputPath}; wrote ${outputPath}`,
    );
  });

export default parseReposFromCsvCommand;
