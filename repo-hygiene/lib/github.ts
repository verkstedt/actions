import picomatch from 'picomatch'

import type { FileContent, Logger, Octokit, RepoMeta } from './types.ts'

/** The HTTP status of a failed Octokit request, or `undefined`. */
export function getHttpStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const { status } = error
    return typeof status === 'number' ? status : undefined
  }
  return undefined
}

/** The message of whatever was thrown. */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The first of `paths` that exists as a file, as `{ sha, path,
 * content }`, or `null`. Other `params` (owner, repo, ref) are passed
 * through to the contents API.
 */
export async function tryGetContent(
  octokit: Octokit,
  {
    paths,
    ...params
  }: { paths: Array<string>; owner: string; repo: string; ref?: string }
): Promise<FileContent | null> {
  for (const path of paths) {
    try {
      const res = await octokit.rest.repos.getContent({ ...params, path })
      if (!Array.isArray(res.data) && 'content' in res.data) {
        return {
          sha: res.data.sha,
          path: res.data.path,
          content: Buffer.from(res.data.content, 'base64').toString('utf8'),
        }
      }
    } catch (e) {
      if (getHttpStatus(e) !== 404) {
        throw e
      }
    }
  }

  return null
}

/**
 * Head commit SHA of `branch` and every path in its tree, each
 * prefixed with `/`. Warns through `log` when the tree was truncated.
 */
export async function fetchBranchTree(
  octokit: Octokit,
  {
    org,
    repo,
    branch,
    log,
  }: { org: string; repo: string; branch: string; log: Logger }
): Promise<{ headSha: string; paths: Array<string> }> {
  const refData = await octokit.rest.git.getRef({
    owner: org,
    repo,
    ref: `heads/${branch}`,
  })
  const headSha = refData.data.object.sha
  const commitData = await octokit.rest.git.getCommit({
    owner: org,
    repo,
    commit_sha: headSha,
  })
  const treeData = await octokit.rest.git.getTree({
    owner: org,
    repo,
    tree_sha: commitData.data.tree.sha,
    recursive: '1',
  })
  if (treeData.data.truncated) {
    log.warning('tree response truncated; detection may be incomplete')
  }
  const paths = (treeData.data.tree || []).map((e) => `/${e.path}`)
  return { headSha, paths }
}

/** Commit `content` to `path` on `branch`; `sha` set means an update. */
export async function commitChange(
  octokit: Octokit,
  {
    org,
    repo,
    branch,
    path,
    content,
    sha,
  }: {
    org: string
    repo: string
    branch: string
    path: string
    content: string
    sha?: string
  }
): Promise<void> {
  await octokit.rest.repos.createOrUpdateFileContents({
    owner: org,
    repo,
    branch,
    path,
    message: sha ? `chore: Update ${path}` : `chore: Add ${path}`,
    content: Buffer.from(content, 'utf8').toString('base64'),
    sha,
  })
}

interface LineCommentParams {
  org: string
  repo: string
  pr: { number: number; head: { sha: string } }
  path: string
  lineNumbers: Array<number>
  body: string
}

/** Leave one review comment spanning `lineNumbers` of `path` on the PR. */
export async function createLineComment(
  octokit: Octokit,
  { org, repo, pr, path, lineNumbers, body }: LineCommentParams
): Promise<void> {
  const startLine = Math.min(...lineNumbers)
  const endLine = Math.max(...lineNumbers)
  const comment: {
    path: string
    body: string
    side: 'RIGHT'
    line: number
    start_line?: number
    start_side?: 'RIGHT'
  } = { path, body, side: 'RIGHT', line: endLine }
  if (startLine !== endLine) {
    comment.start_line = startLine
    comment.start_side = 'RIGHT'
  }
  await octokit.rest.pulls.createReview({
    owner: org,
    repo,
    pull_number: pr.number,
    commit_id: pr.head.sha,
    event: 'COMMENT',
    comments: [comment],
  })
}

/** The App must be installed on every org repo, or the audit is partial. */
export async function assertAppSeesAllRepos(octokit: Octokit): Promise<void> {
  const inst = await octokit.request('GET /installation/repositories', {
    per_page: 1,
  })
  if (inst.data.repository_selection !== 'all') {
    throw new Error(
      `App has repository_selection='${inst.data.repository_selection}'; expected 'all'. Reconfigure the App’s repository access to “All repositories”.`
    )
  }
}

/**
 * Org repos to audit: sources only, skipping archived, disabled and
 * empty ones, narrowed by `reposFilter` picomatch globs when given.
 * Every pattern must match at least one repo.
 */
export async function listTargetRepos(
  octokit: Octokit,
  { org, reposFilter }: { org: string; reposFilter: Array<string> }
): Promise<Array<GitHub.RepoMeta>> {
  const allRepos = await octokit.paginate(octokit.rest.repos.listForOrg, {
    org,
    type: 'sources',
    per_page: 100,
  })
  const targets = allRepos.filter(
    (r): r is typeof r & GitHub.RepoMeta =>
      !r.archived &&
      !r.disabled &&
      (r.size || 0) > 0 &&
      typeof r.default_branch === 'string'
  )
  if (reposFilter.length === 0) {
    return targets
  }

  const matchers = reposFilter.map((pattern) => ({
    pattern,
    isMatch: picomatch(pattern, { dot: true }),
  }))
  const hitPatterns = new Set<string>()
  const matched = targets.filter((r) => {
    const hits = matchers.filter((m) => m.isMatch(r.name))
    hits.forEach((m) => hitPatterns.add(m.pattern))
    return hits.length > 0
  })
  const missing = reposFilter.filter((p) => !hitPatterns.has(p))
  if (missing.length > 0) {
    throw new Error(
      missing
        .map(
          (p) =>
            `Requested repo pattern "${p}" matched no repos in ${org} (after filtering archived/disabled/fork/empty).`
        )
        .join('\n')
    )
  }
  return matched
}
