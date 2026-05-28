type AccessRole = 'admin' | 'maintainer' | 'write';

const ROLE_PRIORITY: Record<AccessRole, number> = {
  write: 1,
  maintainer: 2,
  admin: 3,
};

function mapPermissionToRole(permission: string): AccessRole | null {
  switch (permission) {
    case 'admin':
      return 'admin';
    case 'maintain':
      return 'maintainer';
    case 'write':
    case 'push':
      return 'write';
    default:
      return null;
  }
}

function isHigherRole(candidate: AccessRole, current: AccessRole): boolean {
  return ROLE_PRIORITY[candidate] > ROLE_PRIORITY[current];
}

async function getOrgVerifiedDomainEmails(
  octokit: any,
  username: string,
  org: string,
): Promise<string[]> {
  const query = `
    query GetVerifiedDomainEmails($username: String!, $org: String!) {
      user(login: $username) {
        organizationVerifiedDomainEmails(login: $org)
      }
    }
  `;

  try {
    const response: {
      user: { organizationVerifiedDomainEmails: string[] };
    } = await octokit.graphql(query, { username, org });
    return response.user.organizationVerifiedDomainEmails;
  } catch {
    return [];
  }
}

export async function fetchRepoMaintainers(
  octokit: any,
  owner: string,
  repo: string,
  teamMembersCache: Map<string, string[]>,
  logger: any,
): Promise<string[]> {
  const userMap = new Map<string, AccessRole>();

  // Direct collaborators
  try {
    for await (const response of octokit.paginate.iterator(
      octokit.rest.repos.listCollaborators,
      { owner, repo, affiliation: 'direct', per_page: 100 },
    )) {
      for (const user of response.data) {
        const role = mapPermissionToRole(user.role_name ?? '');
        if (role) {
          userMap.set(user.login, role);
        }
      }
    }
  } catch (error: any) {
    logger.warn(`Could not fetch collaborators for ${repo}: ${error.message}`);
  }

  // Team members
  try {
    for await (const response of octokit.paginate.iterator(
      octokit.rest.repos.listTeams,
      { owner, repo, per_page: 100 },
    )) {
      for (const team of response.data) {
        const teamRole = mapPermissionToRole(team.permission);
        if (!teamRole) continue;

        const cacheKey = `${owner}/${team.slug}`;
        let members = teamMembersCache.get(cacheKey);
        if (!members) {
          members = [];
          for await (const mResponse of octokit.paginate.iterator(
            octokit.rest.teams.listMembersInOrg,
            { org: owner, team_slug: team.slug, per_page: 100 },
          )) {
            for (const m of mResponse.data) {
              members.push(m.login);
            }
          }
          teamMembersCache.set(cacheKey, members);
        }

        for (const login of members) {
          const existing = userMap.get(login);
          if (!existing || isHigherRole(teamRole, existing)) {
            userMap.set(login, teamRole);
          }
        }
      }
    }
  } catch (error: any) {
    logger.warn(`Could not fetch teams for ${repo}: ${error.message}`);
  }

  // Resolve logins to verified domain emails
  const emails: string[] = [];
  for (const login of userMap.keys()) {
    const userEmails = await getOrgVerifiedDomainEmails(octokit, login, owner);
    if (userEmails.length > 0) {
      emails.push(...userEmails);
    } else {
      logger.warn(`No verified domain email for ${login}, using login`);
      emails.push(login);
    }
  }

  return emails.sort();
}
