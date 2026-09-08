#!/usr/bin/env bash
set -euo pipefail

# 1. Build a repo list CSV from a source CSV
# 2. Fetch migration-status / migration-issue custom properties for those repos
# 3. Split the repos into "success" and "not success" lists based on migration-status
#
# Auth: the CLI reads ACCESS_TOKEN / BASE_URL (or the GitHub App vars) from the
# environment, which `varlock run` loads from the project env config. Override
# per-run by exporting them, e.g. ACCESS_TOKEN=ghp_xxx ./temp2/get-migration-status.sh
#
# Usage examples:
#
#   # defaults: temp2/migration-recommendations.csv, target_org/repo_name, org "software"
#   ./temp2/get-migration-status.sh
#
#   # different source CSV and organization
#   INPUT_FILE=./audit/ghec-myorg-repos-20260821.csv \
#   ORG_NAME=myorg \
#   ORG_COLUMN=source_org \
#   ./temp2/get-migration-status.sh
#
#   # GitHub Enterprise Server target
#   BASE_URL=https://github.example.com/api/v3 \
#   ORG_NAME=software \
#   ./temp2/get-migration-status.sh
#
#   # different column names and output location
#   INPUT_FILE=./temp2/my-repos.csv \
#   ORG_COLUMN=org \
#   REPO_COLUMN=repo \
#   OUT_DIR=./output/migration-status \
#   ./temp2/get-migration-status.sh
#
#   # treat a different migration-status value as the "success" bucket
#   SUCCESS_VALUE=completed ./temp2/get-migration-status.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

INPUT_FILE="${INPUT_FILE:-${SCRIPT_DIR}/migration-recommendations.csv}"
ORG_COLUMN="${ORG_COLUMN:-target_org}"
REPO_COLUMN="${REPO_COLUMN:-repo_name}"
ORG_NAME="${ORG_NAME:-software}"
SUCCESS_VALUE="${SUCCESS_VALUE:-success}"
OUT_DIR="${OUT_DIR:-${SCRIPT_DIR}}"

REPO_LIST_FILE="${OUT_DIR}/repo-list.csv"
PROPERTIES_FILE="${OUT_DIR}/migration-properties.csv"
SUCCESS_FILE="${OUT_DIR}/migration-status-success.csv"
NOT_SUCCESS_FILE="${OUT_DIR}/migration-status-not-success.csv"

mkdir -p "${OUT_DIR}"
cd "${REPO_ROOT}"

run_cli() {
  pnpm exec varlock run -- tsx src/index.ts "$@"
}

echo "==> Parsing repositories from ${INPUT_FILE}"
run_cli parse-repos-from-csv \
  --input-file "${INPUT_FILE}" \
  --org-column "${ORG_COLUMN}" \
  --repo-column "${REPO_COLUMN}" \
  --delimiter "/" \
  --include-header false \
  --output-file "${REPO_LIST_FILE}" \
  --force true

# The source CSV can carry placeholder owners (e.g. "none") for repos with no
# migration target; the properties command rejects any owner != ORG_NAME.
TOTAL_REPOS="$(wc -l < "${REPO_LIST_FILE}")"
awk -v org="${ORG_NAME}" 'BEGIN{FS="/"} tolower($1) == tolower(org)' \
  "${REPO_LIST_FILE}" > "${REPO_LIST_FILE}.tmp"
mv "${REPO_LIST_FILE}.tmp" "${REPO_LIST_FILE}"
KEPT_REPOS="$(wc -l < "${REPO_LIST_FILE}")"
echo "    kept ${KEPT_REPOS} of ${TOTAL_REPOS} repositories owned by ${ORG_NAME}"

echo "==> Fetching custom properties for ${ORG_NAME}"
run_cli get-org-repo-custom-properties \
  --org-name "${ORG_NAME}" \
  --repo-list "${REPO_LIST_FILE}" \
  --property-name migration-status \
  --property-name migration-issue \
  --output-file "${PROPERTIES_FILE}" \
  --force true

echo "==> Splitting results on migration-status"
node --input-type=module - "${PROPERTIES_FILE}" "${SUCCESS_FILE}" "${NOT_SUCCESS_FILE}" "${SUCCESS_VALUE}" <<'NODE'
import fs from 'node:fs';
import { parse } from 'csv-parse/sync';

const [propertiesFile, successFile, notSuccessFile, successValue] =
  process.argv.slice(2);

const rows = parse(fs.readFileSync(propertiesFile, 'utf8'), {
  columns: true,
  skip_empty_lines: true,
  trim: true,
});

const statusByRepo = new Map();
for (const row of rows) {
  if (row.property_name !== 'migration-status') continue;
  statusByRepo.set(row.repository_name, (row.property_value ?? '').trim());
}

const success = [];
const notSuccess = [];
for (const [repo, status] of statusByRepo) {
  (status.toLowerCase() === successValue.toLowerCase()
    ? success
    : notSuccess
  ).push(repo);
}

const write = (file, repos) =>
  fs.writeFileSync(
    file,
    repos.length ? `${repos.sort().join('\n')}\n` : '',
    'utf8',
  );

write(successFile, success);
write(notSuccessFile, notSuccess);

console.log(`${success.length} repositories -> ${successFile}`);
console.log(`${notSuccess.length} repositories -> ${notSuccessFile}`);
NODE

echo "==> Done"
