import { Octokit } from 'octokit';
import { RestEndpointMethodTypes } from '@octokit/plugin-rest-endpoint-methods';
import { errorMessage, errorStatus } from '../../utils/errors.js';

export type SecretScanningAlert =
  RestEndpointMethodTypes['secretScanning']['listAlertsForRepo']['response']['data'][number];

export type SecretScanningAlertOptions = {
  owner: string;
  repo: string | undefined;
  repos?: { owner: string; repo: string }[] | undefined;
  state: 'open' | 'resolved' | undefined;
  secret_type: string | undefined;
  resolution: string | undefined;
  validity: string | undefined;
  page: number;
  per_page: number;
  is_publicly_leaked: boolean | undefined;
  is_multi_repo: boolean | undefined;
  hide_secret: boolean | undefined;
};

export type SecretScanningAlertOrgOptions = {
  org: string;
  state: 'open' | 'resolved' | undefined;
  secret_type: string | undefined;
  resolution: string | undefined;
  validity: string | undefined;
  page: number;
  per_page: number;
  is_publicly_leaked: boolean | undefined;
  is_multi_repo: boolean | undefined;
  hide_secret: boolean | undefined;
};

export async function* listAlertsForRepo({
  octokit,
  owner,
  repo,
  state,
  secret_type,
  resolution,
  validity,
  page = 1,
  per_page = 30,
  is_publicly_leaked = undefined,
  is_multi_repo = undefined,
  hide_secret = false,
}: {
  octokit: Octokit;
} & SecretScanningAlertOptions): AsyncGenerator<
  SecretScanningAlert,
  void,
  unknown
> {
  if (!octokit) {
    throw new Error('Octokit instance is required');
  }
  if (!owner) {
    throw new Error('Owner is required');
  }
  if (!repo) {
    throw new Error('Repo is required');
  }

  const iterator = octokit.paginate.iterator(
    octokit.rest.secretScanning.listAlertsForRepo,
    {
      owner,
      repo,
      state,
      secret_type,
      resolution,
      validity,
      is_publicly_leaked,
      per_page: per_page,
      page: page,
      is_multi_repo,
      hide_secret,
    },
  );

  for await (const { data: alerts } of iterator) {
    for (const alert of alerts) {
      yield alert;
    }
  }
}

export async function* listAlertsForRepos({
  octokit,
  repos,
  state,
  secret_type,
  resolution,
  validity,
  page = 1,
  per_page = 30,
  is_publicly_leaked = undefined,
  is_multi_repo = undefined,
  hide_secret = false,
}: {
  octokit: Octokit;
} & SecretScanningAlertOptions): AsyncGenerator<
  SecretScanningAlert & {
    owner: string;
    repo: string;
  },
  void,
  unknown
> {
  if (!repos || repos.length === 0) {
    throw new Error('At least one repository must be specified.');
  }

  for (const { owner, repo } of repos) {
    for await (const alert of listAlertsForRepo({
      octokit,
      owner,
      repo,
      state,
      secret_type,
      resolution,
      validity,
      page,
      per_page,
      is_publicly_leaked,
      is_multi_repo,
      hide_secret,
    })) {
      yield { ...alert, owner, repo };
    }
  }
}

export async function* listAlertsForOrg({
  octokit,
  org,
  state,
  secret_type,
  resolution,
  validity,
  page = 1,
  per_page = 30,
  is_publicly_leaked = undefined,
  is_multi_repo = undefined,
  hide_secret = false,
}: {
  octokit: Octokit;
} & SecretScanningAlertOrgOptions): AsyncGenerator<
  SecretScanningAlert,
  void,
  unknown
> {
  if (!octokit) {
    throw new Error('Octokit instance is required');
  }
  if (!org) {
    throw new Error('Organization is required');
  }

  const iterator = octokit.paginate.iterator(
    octokit.rest.secretScanning.listAlertsForOrg,
    {
      org,
      state,
      secret_type,
      resolution,
      validity,
      is_publicly_leaked,
      per_page: per_page,
      page: page,
      is_multi_repo,
      hide_secret,
    },
  );

  for await (const { data: alerts } of iterator) {
    for (const alert of alerts) {
      yield alert;
    }
  }
}

/**
 * Result of checking for open secret scanning alerts. `unavailable` means the
 * check could not be completed (e.g. missing permissions or an API failure) and
 * is distinct from a completed check that found no alerts.
 */
export type OpenAlertCheckResult =
  | { status: 'ok'; hasOpenAlerts: boolean }
  | { status: 'unavailable'; message: string };

export type OrgOpenAlertReposResult =
  | { status: 'ok'; repositoryFullNames: Set<string> }
  | { status: 'unavailable'; message: string };

/**
 * Wrapper used to run each API call, allowing callers to add retry behavior.
 */
export type ApiExecutor = <T>(operation: () => Promise<T>) => Promise<T>;

const runDirect: ApiExecutor = (operation) => operation();

/**
 * Checks whether a single repository has at least one open secret scanning
 * alert. A 404 means secret scanning is unavailable for the repository, which
 * is treated as "no open alerts" rather than a failure.
 */
export async function hasOpenSecretScanningAlerts({
  octokit,
  owner,
  repo,
  execute = runDirect,
}: {
  octokit: Octokit;
  owner: string;
  repo: string;
  execute?: ApiExecutor;
}): Promise<OpenAlertCheckResult> {
  try {
    const { data } = await execute(() =>
      octokit.rest.secretScanning.listAlertsForRepo({
        owner,
        repo,
        state: 'open',
        per_page: 1,
      }),
    );
    return { status: 'ok', hasOpenAlerts: data.length > 0 };
  } catch (error: unknown) {
    if (errorStatus(error) === 404) {
      return { status: 'ok', hasOpenAlerts: false };
    }
    return {
      status: 'unavailable',
      message: `Failed to check open secret scanning alerts for ${owner}/${repo}: ${errorMessage(error)}`,
    };
  }
}

/**
 * Builds the set of repository full names (lowercased) in an organization that
 * have at least one open secret scanning alert, using a single paginated
 * organization-wide pass instead of one request per repository.
 *
 * Returns `unavailable` when the organization endpoint cannot be used (for
 * example secret scanning is not enabled, or the token lacks scope), so callers
 * can fall back to per-repository checks.
 */
export async function fetchOrgReposWithOpenAlerts({
  octokit,
  org,
  per_page = 100,
  execute = runDirect,
}: {
  octokit: Octokit;
  org: string;
  per_page?: number;
  execute?: ApiExecutor;
}): Promise<OrgOpenAlertReposResult> {
  const repositoryFullNames = new Set<string>();
  let page = 1;

  try {
    while (true) {
      const { data: alerts } = await execute(() =>
        octokit.rest.secretScanning.listAlertsForOrg({
          org,
          state: 'open',
          per_page,
          page,
        }),
      );

      for (const alert of alerts) {
        const fullName = alert.repository?.full_name;
        if (fullName) {
          repositoryFullNames.add(fullName.toLowerCase());
        }
      }

      if (alerts.length < per_page) {
        break;
      }
      page++;
    }
    return { status: 'ok', repositoryFullNames };
  } catch (error: unknown) {
    return {
      status: 'unavailable',
      message: `Failed to list open secret scanning alerts for ${org}: ${errorMessage(error)}`,
    };
  }
}
