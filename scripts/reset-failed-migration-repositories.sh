#!/usr/bin/env bash
#
# Finds source repositories with migration-status=failure and no
# migration-issue, verifies their suffixed target repositories, and optionally
# deletes those targets before resetting the source status.
#
# Dry run:
#   SOURCE_ORG=mysourceorg \
#   TARGET_ORG=mytargetorg \
#   TARGET_SUFFIX=mysuffix \
#   TARGET_HOST=github.example.com \
#   SOURCE_ACCESS_TOKEN=... \
#   TARGET_ACCESS_TOKEN=... \
#   ./scripts/reset-failed-migration-repositories.sh
#
# Execute after reviewing the dry-run output and discovered count:
#   ... ./scripts/reset-failed-migration-repositories.sh \
#     --execute --confirm-count 40
#
# Update the source even when its target repository is already absent:
#   ... ./scripts/reset-failed-migration-repositories.sh \
#     --execute --confirm-count 40 --update-source-if-target-missing
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SOURCE_BASE_URL="${SOURCE_BASE_URL:-https://api.github.com}"
MIGRATION_STATUS_VALUE="${MIGRATION_STATUS_VALUE:-not started}"
OUTPUT_FILE="${OUTPUT_FILE:-${SCRIPT_DIR}/repo-list-failures-without-issue.txt}"
SOURCE_RESET_RECOVERY_FILE="${SOURCE_RESET_RECOVERY_FILE:-${SCRIPT_DIR}/repo-list-source-reset-failures.txt}"

EXECUTE=false
CONFIRM_COUNT=""
UPDATE_SOURCE_IF_TARGET_MISSING=false

usage() {
  cat <<'EOF'
Usage:
  reset-failed-migration-repositories.sh
    [--execute --confirm-count N]
    [--update-source-if-target-missing]

Required environment variables:
  SOURCE_ORG          Source organization containing custom properties
  TARGET_ORG          Target organization containing suffixed repositories
  TARGET_SUFFIX       Suffix appended to each source repository name
  TARGET_HOST         Target GitHub hostname without a scheme or path
  SOURCE_ACCESS_TOKEN Token for source custom-property reads and updates
  TARGET_ACCESS_TOKEN Token for target repository reads and deletion

Optional environment variables:
  SOURCE_BASE_URL             Source API URL (default: https://api.github.com)
  MIGRATION_STATUS_VALUE      Source status value (default: not started)
  OUTPUT_FILE                 Generated owner/repository list
  SOURCE_RESET_RECOVERY_FILE  Repositories whose source status update failed

The script is read-only unless --execute and an exact --confirm-count are both
provided. The confirmed count must match the repositories discovered in that
same run. By default, a missing target is a failure and the source is not
updated; --update-source-if-target-missing explicitly allows that source update.
EOF
}

fail() {
  echo "Error: $*" >&2
  exit 1
}

record_failure() {
  FAILURES+=("$1")
  echo "ERROR: $1" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute)
      EXECUTE=true
      shift
      ;;
    --confirm-count)
      [[ $# -ge 2 ]] || fail "--confirm-count requires a value"
      CONFIRM_COUNT="$2"
      shift 2
      ;;
    --update-source-if-target-missing)
      UPDATE_SOURCE_IF_TARGET_MISSING=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

for variable_name in \
  SOURCE_ORG \
  TARGET_ORG \
  TARGET_SUFFIX \
  TARGET_HOST \
  SOURCE_ACCESS_TOKEN \
  TARGET_ACCESS_TOKEN; do
  [[ -n "${!variable_name:-}" ]] || fail "${variable_name} is required"
done

[[ "${SOURCE_ORG}" =~ ^[A-Za-z0-9-]+$ ]] ||
  fail "SOURCE_ORG contains invalid characters"
[[ "${TARGET_ORG}" =~ ^[A-Za-z0-9-]+$ ]] ||
  fail "TARGET_ORG contains invalid characters"
[[ "${TARGET_HOST}" =~ ^[A-Za-z0-9.-]+$ ]] ||
  fail "TARGET_HOST must be a hostname without a scheme or path"
[[ "${TARGET_SUFFIX}" =~ ^[A-Za-z0-9._-]+$ ]] ||
  fail "TARGET_SUFFIX must contain only letters, numbers, '.', '_', or '-'"
[[ -n "${MIGRATION_STATUS_VALUE}" ]] ||
  fail "MIGRATION_STATUS_VALUE cannot be empty"

if [[ "${EXECUTE}" == "true" ]]; then
  [[ "${CONFIRM_COUNT}" =~ ^[0-9]+$ ]] ||
    fail "--execute requires --confirm-count with a non-negative integer"
elif [[ -n "${CONFIRM_COUNT}" ]]; then
  fail "--confirm-count can only be used with --execute"
fi

[[ "${OUTPUT_FILE}" != "${SOURCE_RESET_RECOVERY_FILE}" ]] ||
  fail "OUTPUT_FILE and SOURCE_RESET_RECOVERY_FILE must be different files"

for command_name in pnpm node gh; do
  command -v "${command_name}" >/dev/null 2>&1 ||
    fail "Required command not found: ${command_name}"
done

cd "${REPO_ROOT}"

mkdir -p "$(dirname "${OUTPUT_FILE}")"
mkdir -p "$(dirname "${SOURCE_RESET_RECOVERY_FILE}")"
: >"${SOURCE_RESET_RECOVERY_FILE}"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf -- "${TMP_DIR}"
}
trap cleanup EXIT

PROPERTIES_FILE="${TMP_DIR}/migration-properties.csv"
MATCHES_FILE="${TMP_DIR}/matching-repositories.txt"
UPDATE_LIST_FILE="${TMP_DIR}/source-update.txt"
TARGET_ERROR_FILE="${TMP_DIR}/target-error.txt"

run_source_cli() {
  ACCESS_TOKEN="${SOURCE_ACCESS_TOKEN}" \
    BASE_URL="${SOURCE_BASE_URL}" \
    pnpm exec varlock run -- tsx src/index.ts "$@"
}

run_target_api() {
  GH_TOKEN="${TARGET_ACCESS_TOKEN}" \
    GH_ENTERPRISE_TOKEN="${TARGET_ACCESS_TOKEN}" \
    gh api --hostname "${TARGET_HOST}" "$@"
}

target_was_not_found() {
  grep -Eq '(^|[^0-9])404([^0-9]|$)' "${TARGET_ERROR_FILE}"
}

update_source_status() {
  local source_ref="$1"
  local failure_context="$2"

  printf '%s\n' "${source_ref}" >"${UPDATE_LIST_FILE}"
  mapfile -t UPDATE_REPOSITORIES <"${UPDATE_LIST_FILE}"
  if [[ "${#UPDATE_REPOSITORIES[@]}" -ne 1 ||
    "${UPDATE_REPOSITORIES[0]}" != "${source_ref}" ]]; then
    printf '%s\n' "${source_ref}" >>"${SOURCE_RESET_RECOVERY_FILE}"
    record_failure \
      "${source_ref}: source update list validation failed ${failure_context}"
    return 1
  fi

  echo "Setting migration-status=\"${MIGRATION_STATUS_VALUE}\" on ${source_ref}"
  if ! run_source_cli set-org-repo-custom-property \
    --org-name "${SOURCE_ORG}" \
    --repo-list "${UPDATE_LIST_FILE}" \
    --property-name migration-status \
    --property-value "${MIGRATION_STATUS_VALUE}"; then
    printf '%s\n' "${source_ref}" >>"${SOURCE_RESET_RECOVERY_FILE}"
    record_failure \
      "${source_ref}: source status update failed ${failure_context}"
    echo "Recovery: set migration-status=\"${MIGRATION_STATUS_VALUE}\" using repo list ${SOURCE_RESET_RECOVERY_FILE}" >&2
    return 1
  fi

  ((UPDATED_COUNT += 1))
}

echo "==> Fetching migration properties from ${SOURCE_ORG}"
run_source_cli get-org-repo-custom-properties \
  --org-name "${SOURCE_ORG}" \
  --property-name migration-status \
  --property-name migration-issue \
  --output-file "${PROPERTIES_FILE}" \
  --force true

node --input-type=module - \
  "${PROPERTIES_FILE}" \
  "${OUTPUT_FILE}" \
  "${MATCHES_FILE}" \
  "${SOURCE_ORG}" <<'NODE'
import fs from 'node:fs';
import { parse } from 'csv-parse/sync';

const [propertiesFile, outputFile, matchesFile, sourceOrg] =
  process.argv.slice(2);
const rows = parse(fs.readFileSync(propertiesFile, 'utf8'), {
  columns: true,
  skip_empty_lines: true,
});

const propertiesByRepository = new Map();
for (const row of rows) {
  let properties = propertiesByRepository.get(row.repository_name);
  if (!properties) {
    properties = new Map();
    propertiesByRepository.set(row.repository_name, properties);
  }
  properties.set(row.property_name, row.property_value);
}

const matches = [...propertiesByRepository]
  .filter(
    ([, properties]) =>
      properties.get('migration-status') === 'failure' &&
      properties.has('migration-issue') &&
      properties.get('migration-issue') === '',
  )
  .map(([repository]) => repository)
  .sort((left, right) => left.localeCompare(right));

const renderLines = (values) => values.length ? `${values.join('\n')}\n` : '';
fs.writeFileSync(
  outputFile,
  renderLines(matches.map((repository) => `${sourceOrg}/${repository}`)),
  'utf8',
);
fs.writeFileSync(matchesFile, renderLines(matches), 'utf8');
NODE

mapfile -t MATCHING_REPOSITORIES <"${MATCHES_FILE}"
MATCH_COUNT="${#MATCHING_REPOSITORIES[@]}"

echo "==> Found ${MATCH_COUNT} matching repositories"
echo "    repository list: ${OUTPUT_FILE}"

if [[ "${EXECUTE}" == "true" && "${CONFIRM_COUNT}" != "${MATCH_COUNT}" ]]; then
  fail "--confirm-count ${CONFIRM_COUNT} does not match discovered count ${MATCH_COUNT}"
fi

if [[ "${MATCH_COUNT}" -eq 0 ]]; then
  echo "==> No repositories require processing"
  exit 0
fi

if [[ "${EXECUTE}" == "true" ]]; then
  echo "==> Execute mode confirmed for ${MATCH_COUNT} repositories"
else
  echo "==> DRY RUN: no repositories or custom properties will be changed"
fi

FAILURES=()
VERIFIED_COUNT=0
DELETED_COUNT=0
UPDATED_COUNT=0
MISSING_TARGET_COUNT=0

for source_repository in "${MATCHING_REPOSITORIES[@]}"; do
  source_ref="${SOURCE_ORG}/${source_repository}"
  target_repository="${source_repository}${TARGET_SUFFIX}"
  target_ref="${TARGET_ORG}/${target_repository}"
  target_endpoint="repos/${TARGET_ORG}/${target_repository}"

  echo
  echo "==> ${source_ref} -> ${TARGET_HOST}/${target_ref}"

  if ! target_identity="$(
    run_target_api \
      --method GET \
      "${target_endpoint}" \
      --jq '[.owner.login, .name] | @tsv' \
      2>"${TARGET_ERROR_FILE}"
  )"; then
    target_error="$(<"${TARGET_ERROR_FILE}")"
    if target_was_not_found &&
      [[ "${UPDATE_SOURCE_IF_TARGET_MISSING}" == "true" ]]; then
      ((MISSING_TARGET_COUNT += 1))
      echo "Target not found: ${TARGET_HOST}/${target_ref}"
      if [[ "${EXECUTE}" == "true" ]]; then
        update_source_status "${source_ref}" \
          "after target repository was not found" || true
      else
        echo "DRY RUN: would set migration-status=\"${MIGRATION_STATUS_VALUE}\" on ${source_ref}"
      fi
      continue
    fi
    record_failure "${target_ref}: target lookup failed: ${target_error}"
    continue
  fi

  IFS=$'\t' read -r actual_owner actual_repository <<<"${target_identity}"
  if [[ "${actual_owner}" != "${TARGET_ORG}" ||
    "${actual_repository}" != "${target_repository}" ]]; then
    record_failure \
      "${target_ref}: identity mismatch; API returned ${actual_owner}/${actual_repository}"
    continue
  fi

  ((VERIFIED_COUNT += 1))

  if [[ "${EXECUTE}" != "true" ]]; then
    echo "DRY RUN: would delete ${TARGET_HOST}/${target_ref}"
    echo "DRY RUN: would set migration-status=\"${MIGRATION_STATUS_VALUE}\" on ${source_ref}"
    continue
  fi

  echo "Deleting ${TARGET_HOST}/${target_ref}"
  if ! run_target_api \
    --method DELETE \
    "${target_endpoint}" \
    --silent \
    2>"${TARGET_ERROR_FILE}"; then
    target_error="$(<"${TARGET_ERROR_FILE}")"
    record_failure "${target_ref}: deletion failed: ${target_error}"
    continue
  fi
  ((DELETED_COUNT += 1))

  update_source_status "${source_ref}" "after target deletion" || true
done

echo
echo "==> Summary"
echo "    matched:  ${MATCH_COUNT}"
echo "    verified: ${VERIFIED_COUNT}"
if [[ "${EXECUTE}" == "true" ]]; then
  echo "    deleted:  ${DELETED_COUNT}"
  echo "    updated:  ${UPDATED_COUNT}"
fi
echo "    missing targets allowed: ${MISSING_TARGET_COUNT}"
echo "    failures: ${#FAILURES[@]}"

if [[ "${#FAILURES[@]}" -gt 0 ]]; then
  echo >&2
  echo "Failures:" >&2
  for failure_message in "${FAILURES[@]}"; do
    echo "  - ${failure_message}" >&2
  done
  if [[ -s "${SOURCE_RESET_RECOVERY_FILE}" ]]; then
    echo "Source reset recovery list: ${SOURCE_RESET_RECOVERY_FILE}" >&2
    {
      printf '%s' 'Recovery command: ACCESS_TOKEN="$SOURCE_ACCESS_TOKEN" '
      printf 'BASE_URL=%q pnpm exec varlock run -- tsx src/index.ts ' \
        "${SOURCE_BASE_URL}"
      printf 'set-org-repo-custom-property --org-name %q --repo-list %q ' \
        "${SOURCE_ORG}" "${SOURCE_RESET_RECOVERY_FILE}"
      printf '%s' '--property-name migration-status --property-value '
      printf '%q\n' "${MIGRATION_STATUS_VALUE}"
    } >&2
  fi
  exit 1
fi

echo "==> Done"
