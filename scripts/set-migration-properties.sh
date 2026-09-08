#!/usr/bin/env bash
#
# Sets custom properties on the repositories listed in temp/repo-list.txt
#
# Replace the placeholder values below before running.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ---- Placeholders: fill these in ------------------------------------------
ORG_NAME="${ORG_NAME:-<ORG_NAME>}"
ACCESS_TOKEN="${ACCESS_TOKEN:-<ACCESS_TOKEN>}"
BASE_URL="${BASE_URL:-https://api.github.com}"
CLEAR_MIGRATION_ISSUE="${CLEAR_MIGRATION_ISSUE:-false}"
MIGRATION_STATUS_VALUE="${MIGRATION_STATUS:-<MIGRATION_STATUS>}"
# ---------------------------------------------------------------------------

REPO_LIST="${REPO_LIST:-${SCRIPT_DIR}/repo-list.txt}"

MIGRATION_STATUS_PROPERTY="migration-status"
MIGRATION_ISSUE_PROPERTY="migration-issue"

if [[ "${CLEAR_MIGRATION_ISSUE}" != "true" && "${CLEAR_MIGRATION_ISSUE}" != "false" ]]; then
  echo "CLEAR_MIGRATION_ISSUE must be true or false." >&2
  exit 1
fi

if [[ "${ORG_NAME}" == "<ORG_NAME>" || "${ACCESS_TOKEN}" == "<ACCESS_TOKEN>" || "${MIGRATION_STATUS}" == "<MIGRATION_STATUS>" ]]; then
  echo "Set ORG_NAME, ACCESS_TOKEN, and MIGRATION_STATUS (env vars or edit this script) before running." >&2
  exit 1
fi

if [[ ! -f "${REPO_LIST}" ]]; then
  echo "Repo list not found: ${REPO_LIST}" >&2
  exit 1
fi

cd "${REPO_ROOT}"

run_set_property() {
  pnpm dev set-org-repo-custom-property \
    --org-name "${ORG_NAME}" \
    --access-token "${ACCESS_TOKEN}" \
    --base-url "${BASE_URL}" \
    --repo-list "${REPO_LIST}" \
    "$@"
}

echo "Setting ${MIGRATION_STATUS_PROPERTY}=\"${MIGRATION_STATUS_VALUE}\" ..."
run_set_property \
  --property-name "${MIGRATION_STATUS_PROPERTY}" \
  --property-value "${MIGRATION_STATUS_VALUE}"

if [[ "${CLEAR_MIGRATION_ISSUE}" == "true" ]]; then
  echo "Clearing ${MIGRATION_ISSUE_PROPERTY} ..."
  run_set_property \
    --property-name "${MIGRATION_ISSUE_PROPERTY}" \
    --clear true
fi

echo "Done."
