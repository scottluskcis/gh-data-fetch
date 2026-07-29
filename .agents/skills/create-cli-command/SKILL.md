---
name: create-cli-command
description: Create and wire a brand-new CLI command under src/commands using this repository's shared command, Varlock, utility, testing, and validation conventions.
---

# Create a CLI command

Use this skill only for brand-new commands in `src/commands/`. Do not invoke it
for routine edits or rewrites of existing commands.

## Gather requirements

Before editing, determine:

- the kebab-case command name and concise description;
- the GitHub API operation and required authentication;
- command-specific inputs, defaults, and validation;
- output format and destination;
- expected handling for missing data, API failures, and partial results; and
- parsers, transformations, or domain logic that can be unit tested without a
  live GitHub API.

If any decision is missing or meaningfully ambiguous, interview the user one
decision at a time. Prefer concrete choices and recommend the safest
repository-consistent option. Start implementation after the behavior is
defined.

## Inspect before writing

1. Read `src/commands/command-helpers.ts`, `src/index.ts`,
   `.vscode/launch.json`, `.env.schema`, and `package.json`.
2. Review `resources/command-template.ts` and relevant commands, especially
   commands that use `createCommandWithSharedOptions`.
3. Search `src/utils/`, `src/api/`, and existing command options before adding
   helpers, API wrappers, or environment variables.
4. Preserve unrelated work in a dirty worktree.

## Implement the command

1. Create `src/commands/<command-name>.ts` from the resource template.
2. Build the command with `createCommandWithSharedOptions`; do not use
   `createBaseCommand` or construct `Command` directly.
3. Run authenticated work through `executeWithOctokit`.
   - A callback containing one safe API operation may use the default
     whole-callback retry behavior.
   - For workflows with multiple API requests, pagination, persisted progress,
     or side effects, prevent a later failure from replaying earlier work. Call
     `executeWithOctokit` once with a copied options object whose
     `retryDisabled` value is `true`, then use the harness's `withRetry` around
     each independent API operation.
   - Preserve the user's original retry settings before disabling the outer
     retry. Honor `retryDisabled`, use the configured attempt and backoff
     values, and log operation-specific retry context.
   - Keep state mutations outside retry callbacks. Fetch pagination one page at
     a time when practical, and retry each idempotent update batch separately
     so completed pages or batches are not repeated.
   - Do not retry local parsing, validation, or output writes. Avoid retrying
     non-idempotent API operations unless they have an idempotency mechanism or
     an explicit recovery strategy.
4. Add command-specific options with Commander `Option`. Every such option must
   call `.env('VARIABLE_NAME')`.
5. Reuse a semantically equivalent variable already declared in `.env.schema`.
   If none exists, add the variable to the appropriate schema section with an
   accurate Varlock type, safe default when appropriate, and `@sensitive` for
   secrets. Never read `process.env` directly or duplicate an existing
   variable under another name.
6. Keep orchestration close to the command. Put logic in `src/utils/` only when
   it is reused by multiple commands or is independently testable domain logic.
   Reuse existing utilities before creating a new one.
7. Use strict types and `unknown` error narrowing. Do not add `any`, broad
   catches, silent early returns, or success-shaped fallbacks.
8. Export the command as the default export.

## Wire every command

1. Import the command in `src/index.ts` and add it to the `commands` array.
2. Add the command name to the `command` picker in `.vscode/launch.json`,
   keeping the list in alphabetical order.
3. Confirm every new `.env(...)` name has a matching `.env.schema` declaration
   and every schema addition is used.

## Test and validate

- Add unit tests for parsers, transformations, and reusable domain logic.
- Never call a live GitHub API from tests. Use typed fixtures or mocks only
  when a boundary must be exercised.
- Use Vitest for unit tests. Put `*.test.ts` files under `tests/` in a directory
  structure that mirrors `src/` rather than colocating tests with source files.
  For example, tests for `src/utils/example.ts` belong in
  `tests/utils/example.test.ts`, and tests for `src/commands/example.ts` belong
  in `tests/commands/example.test.ts`. If Vitest is not configured, initialize
  it before adding tests; do not introduce a different test framework without
  explicit user approval.
- Run the smallest relevant tests first, then the repository's existing
  `pnpm test`, `pnpm lint`, `pnpm format:check`, and `pnpm bundle` commands.
  Because `pnpm bundle` runs the formatter in write mode, review its changes
  and rerun affected checks as needed.
- Fix failures caused by the new command. Do not claim completion while its
  tests, lint, formatting, packaging, registration, launch entry, or Varlock
  declarations are incomplete.
