import { getErrorMessage, getHttpStatus } from './github.ts';
import type {
  CodeownersLine,
  Logger,
  Octokit,
  ReviewerSource,
} from './types.ts';

const KNOWN_BOTS = new Set(['dependabot', 'github-actions', 'renovate']);

/** GitHub allows at most this many requested reviewers on a PR. */
const MAX_REVIEWERS = 15;

/**
 * Split CODEOWNERS owner tokens into unique user logins and team
 * slugs, without the `@` and org prefixes.
 */
export function splitReviewers(ownerTokens: Array<string>): {
  users: Array<string>;
  teams: Array<string>;
} {
  const logins = ownerTokens
    .map((tok) => tok.replace(/^@/, ''))
    .filter(Boolean);
  const { users = [], teams = [] } = Object.groupBy(logins, (login) =>
    login.includes('/') ? 'teams' : 'users',
  );
  const slugs = teams.map((team) => team.split('/')[1]).filter(Boolean);
  return { users: [...new Set(users)], teams: [...new Set(slugs)] };
}

interface Contributor {
  login?: string;
  type?: string;
}

async function listHumanContributors(
  octokit: Octokit,
  { org, repo }: { org: string; repo: string },
): Promise<Array<Contributor & { login: string }>> {
  let contribs: Array<Contributor> = [];
  try {
    const { data } = await octokit.rest.repos.listContributors({
      owner: org,
      repo,
      per_page: 100,
    });
    contribs = Array.isArray(data) ? data : [];
  } catch (e) {
    const status = getHttpStatus(e);
    if (status !== 404 && status !== 204) {
      throw e;
    }
  }
  return contribs.filter(
    (c): c is Contributor & { login: string } =>
      c.type === 'User' &&
      typeof c.login === 'string' &&
      !c.login.endsWith('[bot]') &&
      !KNOWN_BOTS.has(c.login),
  );
}

/**
 * Where GitHub looks for CODEOWNERS, in order of precedence, per
 * https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners#codeowners-file-location
 */
export const CODEOWNERS_PATHS = [
  '.github/CODEOWNERS',
  'CODEOWNERS',
  'docs/CODEOWNERS',
];

/** `reviewer: @a`, `reviewers: @a, @b`, or `no reviewer assigned`. */
export function describeReviewers(reviewers: Array<string>): string {
  if (reviewers.length === 0) {
    return 'no reviewer assigned';
  }
  const label = reviewers.length === 1 ? 'reviewer' : 'reviewers';
  return `${label}: ${reviewers.join(', ')}`;
}

/** `@user` and `@org/team` handles for the split reviewers. */
export function formatReviewerHandles(
  org: string,
  { users, teams }: { users: Array<string>; teams: Array<string> },
): Array<string> {
  return [...users.map((u) => `@${u}`), ...teams.map((t) => `@${org}/${t}`)];
}

interface ChooseReviewersParams {
  org: string;
  repo: string;
  /** Owner tokens suggested by the findings going into the PR. */
  suggested: Array<string>;
  /** The CODEOWNERS on the default branch. */
  parsedLines: Array<CodeownersLine>;
}

interface ChosenReviewers {
  reviewerTokens: Array<string>;
  reviewerSource: ReviewerSource;
}

/**
 * Who should review the hygiene PR. Tries, in order: the suggested
 * owners, any owner in CODEOWNERS, then human contributors.
 */
export async function chooseReviewers(
  octokit: Octokit,
  { org, repo, suggested, parsedLines }: ChooseReviewersParams,
): Promise<ChosenReviewers> {
  if (suggested.length > 0) {
    return {
      reviewerTokens: [...new Set(suggested)],
      reviewerSource: 'codeowners-match',
    };
  }
  const allOwners = new Set<string>();
  for (const line of parsedLines) {
    line.owners.forEach((o) => allOwners.add(o));
  }
  if (allOwners.size > 0) {
    return {
      reviewerTokens: [...allOwners],
      reviewerSource: 'codeowners-fallback',
    };
  }
  const humans = await listHumanContributors(octokit, { org, repo });
  if (humans.length > 0) {
    return {
      reviewerTokens: humans.map((h) => `@${h.login}`),
      reviewerSource: 'contributors',
    };
  }
  return { reviewerTokens: [], reviewerSource: 'none' };
}

interface RequestedReviewers {
  users: Array<{ login: string }>;
  teams: Array<{ slug: string }>;
}

interface RequestReviewersParams {
  org: string;
  repo: string;
  pullNumber: number;
  users: Array<string>;
  teams: Array<string>;
  log: Logger;
}

/**
 * Request reviewers one at a time. requestReviewers is all-or-nothing:
 * a single invalid entry (e.g. a past contributor who is no longer
 * a collaborator, or a team without repo access) 422s the whole call.
 * Requesting each reviewer separately — calls are additive — means
 * a bad entry only drops itself while the valid reviewers still get
 * assigned. Any other request failure (auth, rate limit, server error) is
 * rethrown so the audit reports it instead of a partial success.
 * Stops once MAX_REVIEWERS have been accepted, so an invalid candidate
 * does not use up a slot. Returns the reviewers that were requested,
 * as `@` handles.
 *
 * GitHub requests code owners on its own when the PR is opened, and
 * then rejects requesting them again with a 422. So on a 422 the PR’s
 * requested reviewers are read back, and a reviewer already there
 * counts as requested. This lookup is cached on first use; a failed
 * lookup is warned about without stopping later requests.
 */
export async function requestReviewersOneByOne(
  octokit: Octokit,
  { org, repo, pullNumber, users, teams, log }: RequestReviewersParams,
): Promise<Array<string>> {
  const pr = { owner: org, repo, pull_number: pullNumber };
  const candidates = [
    ...users.map((user) => ({
      handle: `@${user}`,
      label: 'reviewer',
      params: { reviewers: [user] },
      isListed: ({ users: listed }: RequestedReviewers) =>
        listed.some((u) => u.login.toLowerCase() === user.toLowerCase()),
    })),
    ...teams.map((team) => ({
      handle: `@${org}/${team}`,
      label: 'team reviewer',
      params: { team_reviewers: [team] },
      isListed: ({ teams: listed }: RequestedReviewers) =>
        listed.some((t) => t.slug.toLowerCase() === team.toLowerCase()),
    })),
  ];
  const requested: Array<string> = [];
  let requestedReviewers: RequestedReviewers | undefined;
  for (const { handle, label, params, isListed } of candidates) {
    if (requested.length >= MAX_REVIEWERS) {
      break;
    }
    try {
      await octokit.rest.pulls.requestReviewers({ ...pr, ...params });
      requested.push(handle);
    } catch (e) {
      if (getHttpStatus(e) !== 422) {
        throw e;
      }
      if (!requestedReviewers) {
        try {
          requestedReviewers = (
            await octokit.rest.pulls.listRequestedReviewers(pr)
          ).data;
        } catch (lookupError) {
          log.warning(
            `could not list requested reviewers: ${getErrorMessage(lookupError)}`,
          );
        }
      }
      if (requestedReviewers && isListed(requestedReviewers)) {
        requested.push(handle);
      } else {
        log.warning(
          `could not request ${label} ${handle}: ${getErrorMessage(e)}`,
        );
      }
    }
  }
  return requested;
}
