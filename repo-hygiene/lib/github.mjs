/**
 * The first of `paths` that exists as a file, as `{ sha, path,
 * content }`, or `null`. Other `params` (owner, repo, ref) are passed
 * through to the contents API.
 */
export async function tryGetContent(octokit, { paths, ...params }) {
  for (const path of paths) {
    try {
      const res = await octokit.rest.repos.getContent({ ...params, path })
      if (!Array.isArray(res.data)) {
        return {
          sha: res.data.sha,
          path: res.data.path,
          content: Buffer.from(res.data.content, 'base64').toString('utf8'),
        }
      }
    } catch (e) {
      if (e.status !== 404) {
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
export async function fetchBranchTree(octokit, { org, repo, branch, log }) {
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

/**
 * Commit a `{ path, newContent, sha? }` change onto `branch`. `sha`
 * present means the file is being updated rather than added.
 */
export async function commitChange(octokit, { org, repo, branch, change }) {
  await octokit.rest.repos.createOrUpdateFileContents({
    owner: org,
    repo,
    branch,
    path: change.path,
    message: change.sha
      ? `chore: Update ${change.path}`
      : `chore: Add ${change.path}`,
    content: Buffer.from(change.newContent, 'utf8').toString('base64'),
    sha: change.sha,
  })
}

/**
 * Leave a single review comment spanning `lineNumbers` of `path` on
 * the PR. Failure to comment is logged through `log`, not thrown.
 */
export async function createLineComment(
  octokit,
  { org, repo, pr, path, lineNumbers, body, log }
) {
  const startLine = Math.min(...lineNumbers)
  const endLine = Math.max(...lineNumbers)
  const comment = { path, body, side: 'RIGHT', line: endLine }
  if (startLine !== endLine) {
    comment.start_line = startLine
    comment.start_side = 'RIGHT'
  }
  try {
    await octokit.rest.pulls.createReview({
      owner: org,
      repo,
      pull_number: pr.number,
      commit_id: pr.head.sha,
      event: 'COMMENT',
      comments: [comment],
    })
  } catch (e) {
    log.warning(`could not create review comment: ${e.message}`)
  }
}
