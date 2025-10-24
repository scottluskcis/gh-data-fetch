import { Octokit } from 'octokit';
import { RestEndpointMethodTypes } from '@octokit/plugin-rest-endpoint-methods';

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
