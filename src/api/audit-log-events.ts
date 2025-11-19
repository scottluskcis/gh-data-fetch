import { Octokit } from 'octokit';

/*

action:repo.remove_member 
org:software 
created:>=2025-11-17T22:00:00Z 
created:<2025-11-17T23:00:00Z 
repo:software/dtc-release-cicd

*/
/**
 * Get audit log activity for a repository filtered by usernames and optional criteria
 * @param octokit - The Octokit instance
 * @param orgName - The organization name
 * @param repoName - The repository name
 * @param usernames - Array of usernames to filter audit log events by
 * @param sinceIso - Optional ISO date string to filter events after this date
 * @param action - Optional action type to filter by (e.g., "repo.create", "repo.destroy")
 * @param created - Optional creation date filter (e.g., ">=2025-11-17T22:00:00Z")
 * @param include - Filter by event source: "all", "web", or "git". Defaults to "all"
 * @yields Objects containing actor username, action type, and event date
 */
export async function* getAuditLogActivity({
  octokit,
  orgName,
  enterpriseName,
  repoName,
  usernames,
  sinceIso,
  action,
  created,
  include = 'all',
  type = 'org',
}: {
  octokit: Octokit;
  orgName?: string;
  enterpriseName?: string;
  repoName?: string;
  usernames?: string[];
  sinceIso?: string;
  action?: string | string[];
  created?: string | string[];
  include?: 'all' | 'web' | 'git';
  type: 'org' | 'enterprise';
}): AsyncGenerator<{ actor: string; action: string; date: Date; props: any }> {
  if (type == 'org' && !orgName) {
    throw new Error('orgName is required');
  }
  if (type == 'enterprise' && !enterpriseName) {
    throw new Error('enterpriseName is required');
  }

  // stop processing after specified date
  const sinceDate = sinceIso ? new Date(sinceIso) : undefined;

  // Build the actor phrase to filter by users
  const actorPhrase = usernames
    ? Array.from(usernames)
        .map((username) => `actor:${username}`)
        .join(' ')
    : '';

  // Build the action phrase to filter by action
  const actionPhrase = action
    ? Array.isArray(action)
      ? action.map((a) => `action:${a}`).join(' ')
      : `action:${action}`
    : '';

  // Build the created phrase to filter by date
  const createdPhrase = created
    ? Array.isArray(created)
      ? created.map((c) => `created:${c}`).join(' ')
      : `created:${created}`
    : '';

  const repoPhrase = repoName ? `repo:${orgName}/${repoName}` : '';

  const orgPhrase = orgName ? `org:${orgName}` : '';

  const actionPhrases = [
    actionPhrase,
    orgPhrase,
    repoPhrase,
    actorPhrase,
    createdPhrase,
  ].filter((phrase) => phrase.trim().length > 0);

  // Build the full search phrase
  const phrase = actionPhrases.join(' ').trim();

  const url =
    type == 'org'
      ? 'GET /orgs/{org}/audit-log'
      : 'GET /enterprises/{enterprise}/audit-log';

  // use pagination to fetch all audit log events matching the criteria
  const iterator = octokit.paginate.iterator(url, {
    org: orgName,
    enterprise: enterpriseName,
    phrase: phrase,
    order: 'desc',
    include: include,
    per_page: 30,
  });

  let continueFetching = true;
  for await (const { data: events } of iterator) {
    for (const event of events) {
      const eventDate = new Date((event as any)['@timestamp']);

      if (sinceDate && eventDate < sinceDate) {
        continueFetching = false;
        break;
      }

      const data: any = event as any;
      yield {
        actor: data.actor,
        action: data.action,
        date: eventDate,
        props: { ...(event as any) },
      };
    }
    if (!continueFetching) {
      break;
    }
  }
}
