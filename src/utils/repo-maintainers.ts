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

function isLikelyBot(value: string): boolean {
  const botPatterns = [
    /\[bot\]$/i,
    /^bot-/i,
    /-bot$/i,
    /^github-actions/i,
    /^dependabot/i,
    /^app\/\w+/i,
    /^github-pages/i,
    /^renovate/i,
    /no-?reply@\w+\.\w+$/i,
    /\bautomat(ed|ion)\b/i,
  ];
  return botPatterns.some((pattern) => pattern.test(value));
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
  excludeTeams: Set<string> = new Set(),
  includeUsers: 'all' | 'direct' | 'teams' = 'all',
  teamRoleToInclude: 'all' | 'admin' | 'maintainer' | 'write' = 'all',
  maxUsers: number = 25,
): Promise<string[]> {
  const userMap = new Map<string, AccessRole>();

  // Direct collaborators
  if (includeUsers === 'all' || includeUsers === 'direct') {
    try {
      for await (const response of octokit.paginate.iterator(
        octokit.rest.repos.listCollaborators,
        { owner, repo, affiliation: 'direct', per_page: 100 },
      )) {
        for (const user of response.data) {
          if (isLikelyBot(user.login)) continue;
          const role = mapPermissionToRole(user.role_name ?? '');
          if (role) {
            userMap.set(user.login, role);
          }
        }
      }
    } catch (error: any) {
      logger.warn(
        `Could not fetch collaborators for ${repo}: ${error.message}`,
      );
    }
  }

  // Team members - collect teams first, sort by role priority, then fetch members
  if (includeUsers === 'all' || includeUsers === 'teams') {
    try {
      const teams: { slug: string; permission: string }[] = [];
      for await (const response of octokit.paginate.iterator(
        octokit.rest.repos.listTeams,
        { owner, repo, per_page: 100 },
      )) {
        for (const team of response.data) {
          if (excludeTeams.has(team.slug.toLowerCase())) continue;
          const teamRole = mapPermissionToRole(team.permission);
          if (
            !teamRole ||
            (teamRoleToInclude != 'all' &&
              teamRole.toLowerCase() != teamRoleToInclude)
          )
            continue;
          teams.push({ slug: team.slug, permission: team.permission });
        }
      }

      // Sort teams by role priority (admin teams first)
      teams.sort((a, b) => {
        const roleA = mapPermissionToRole(a.permission)!;
        const roleB = mapPermissionToRole(b.permission)!;
        return ROLE_PRIORITY[roleB] - ROLE_PRIORITY[roleA];
      });

      for (const team of teams) {
        const teamRole = mapPermissionToRole(team.permission)!;

        // If we already have enough users at this role level or higher, stop
        const usersAtOrAbove = [...userMap.values()].filter(
          (r) => ROLE_PRIORITY[r] >= ROLE_PRIORITY[teamRole],
        ).length;
        if (usersAtOrAbove >= maxUsers) break;

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
          if (isLikelyBot(login)) continue;
          const existing = userMap.get(login);
          if (!existing || isHigherRole(teamRole, existing)) {
            userMap.set(login, teamRole);
          }
        }
      }
    } catch (error: any) {
      logger.warn(`Could not fetch teams for ${repo}: ${error.message}`);
    }
  }

  // Sort users by role priority (admin > maintainer > write) and limit to maxUsers
  const sortedUsers = [...userMap.entries()]
    .sort((a, b) => ROLE_PRIORITY[b[1]] - ROLE_PRIORITY[a[1]])
    .slice(0, maxUsers);

  // Resolve logins to verified domain emails
  const emails: string[] = [];
  for (const [login] of sortedUsers) {
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
