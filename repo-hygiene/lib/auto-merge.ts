import type { RepoSnapshot } from './snapshot.ts';
import type { GitHub } from './types.ts';

export type MergeMethod = 'merge' | 'squash' | 'rebase';

/** In order of preference. */
const MERGE_METHODS: Array<MergeMethod> = ['merge', 'squash', 'rebase'];

const REPO_SETTING: Record<MergeMethod, keyof GitHub.Repository> = {
  merge: 'allow_merge_commit',
  squash: 'allow_squash_merge',
  rebase: 'allow_rebase_merge',
};

interface BranchRule {
  type: string;
  parameters?: {
    required_approving_review_count?: number;
    allowed_merge_methods?: Array<MergeMethod>;
  };
}

/**
 * The merge method to auto-merge with when the default branch’s
 * rulesets require at least one approving review; `null` when they
 * do not, or when no merge method is allowed by both the rulesets and
 * the repo settings.
 */
export async function planAutoMerge(
  snapshot: RepoSnapshot,
): Promise<MergeMethod | null> {
  const { octokit, org, repo, defaultBranch } = snapshot;
  const rules = (await octokit.paginate(octokit.rest.repos.getBranchRules, {
    owner: org,
    repo,
    branch: defaultBranch,
    per_page: 100,
  })) as Array<BranchRule>;
  const prRules = rules.filter(
    (r) =>
      r.type === 'pull_request' &&
      (r.parameters?.required_approving_review_count ?? 0) > 0,
  );
  if (prRules.length === 0) {
    return null;
  }
  const repository = await snapshot.getRepository();
  return (
    MERGE_METHODS.find(
      (method) =>
        repository[REPO_SETTING[method]] !== false &&
        prRules.every(
          (r) => r.parameters?.allowed_merge_methods?.includes(method) ?? true,
        ),
    ) ?? null
  );
}

/** Turns on auto-merge for `pr`. */
export async function enableAutoMerge(
  snapshot: RepoSnapshot,
  pr: GitHub.PullRequest,
  mergeMethod: MergeMethod,
): Promise<void> {
  await snapshot.octokit.graphql(
    `mutation($id: ID!, $method: PullRequestMergeMethod!) {
      enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) {
        clientMutationId
      }
    }`,
    { id: pr.node_id, method: mergeMethod.toUpperCase() },
  );
}
