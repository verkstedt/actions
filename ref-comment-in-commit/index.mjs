import * as core from '@actions/core'
import * as github from '@actions/github'

const context = github.context ?? {}
const { payload } = context

const token = core.getInput('token')

/**
 * @doc https://octokit.github.io/rest.js
 */
const octokit = github.getOctokit(token)

/**
 * Hidden marker we put in every reply we post, so that we can tell our own
 * replies apart from anything else in the thread.
 */
function marker(sha) {
  return `<!-- verkstedt/ref-comment-in-commit/${sha} -->`
}

/**
 * The REST API has no way of fetching a single review thread, so we ask
 * GraphQL for all of them at once. Unlike `pulls.listReviewComments`, this
 * pages over threads rather than over individual comments, which keeps busy
 * pull requests down to a single request.
 */
const REVIEW_THREADS_QUERY = `
  query ($owner: String!, $repo: String!, $prNumber: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $prNumber) {
        reviewThreads(first: 50, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            recent: comments(last: 100) {
              pageInfo {
                hasPreviousPage
              }
              nodes {
                databaseId
                body
              }
            }
            oldest: comments(first: 100) {
              nodes {
                databaseId
              }
            }
          }
        }
      }
    }
  }
`

/**
 * Review threads of a pull request, keyed by `owner/repo#number`.
 *
 * A single push can reference the same pull request from many commits, so we
 * only ever fetch each one once.
 *
 * @type {Map<string, Promise<Array<{ id: string, commentIds: number[], bodies: string[] }>>>}
 */
const pullRequestThreads = new Map()

async function fetchPullRequestThreads({ owner, repo, prNumber }) {
  const threads = []
  let cursor = null
  let hasNextPage = true
  while (hasNextPage) {
    const { repository } = await octokit.graphql(REVIEW_THREADS_QUERY, {
      owner,
      repo,
      prNumber,
      cursor,
    })
    const pullRequest = repository?.pullRequest
    if (!pullRequest) {
      core.warning(
        `No pull request ${owner}/${repo}#${prNumber} found; skipping duplicate check`
      )
      return threads
    }
    const { reviewThreads } = pullRequest
    reviewThreads.nodes.forEach((thread) => {
      if (thread.recent.pageInfo.hasPreviousPage) {
        core.warning(
          `Thread in ${owner}/${repo}#${prNumber} has more than 100 comments; only the 100 most recent ones are checked for duplicates`
        )
      }
      threads.push({
        id: thread.id,
        // Both ends of the thread, so that the referenced comment is still
        // found in it when the thread is too long to fetch in full.
        commentIds: [
          ...thread.recent.nodes.map(({ databaseId }) => databaseId),
          ...thread.oldest.nodes.map(({ databaseId }) => databaseId),
        ],
        bodies: thread.recent.nodes.map(({ body }) => body ?? ''),
      })
    })
    hasNextPage = reviewThreads.pageInfo.hasNextPage
    cursor = reviewThreads.pageInfo.endCursor
  }
  return threads
}

function getPullRequestThreads({ owner, repo, prNumber }) {
  const key = `${owner}/${repo}#${prNumber}`
  if (!pullRequestThreads.has(key)) {
    pullRequestThreads.set(
      key,
      // Only successful fetches are worth keeping, so that a commit is not
      // dropped because of a failure another commit ran into.
      fetchPullRequestThreads({ owner, repo, prNumber }).catch((error) => {
        pullRequestThreads.delete(key)
        throw error
      })
    )
  }
  return pullRequestThreads.get(key)
}

/**
 * The thread that `commentId` belongs to, if we could fetch it.
 *
 * `commentId` may point at a reply rather than at the top comment of
 * a thread, hence looking for it anywhere in the thread.
 */
async function getThread({ owner, repo, prNumber, commentId }) {
  const threads = await getPullRequestThreads({ owner, repo, prNumber })
  return threads.find(({ commentIds }) => commentIds.includes(commentId))
}

function isAlreadyReferenced(bodies, sha) {
  return bodies.some((body) => body.includes(marker(sha)))
}

/**
 * References we have posted ourselves, as `<thread>/<sha>`.
 *
 * A single commit message can point at more than one comment of the same
 * thread, and all of its references are handled at the same time — early
 * enough for each of them to still see a thread without our reply in it.
 *
 * @type {Set<string>}
 */
const postedReferences = new Set()

/**
 * Claims a reference for posting, telling us whether it was ours to claim.
 *
 * Must not be awaited half way through, so that two references of the same
 * commit cannot both claim the same thread.
 */
function claimReference({ owner, repo, prNumber, threadId, commentId, sha }) {
  // Falling back to the comment when the thread is unknown, which at worst
  // claims the same thread twice under two different keys.
  const key = `${owner}/${repo}#${prNumber}/${threadId ?? `r${commentId}`}/${sha}`
  if (postedReferences.has(key)) {
    return false
  }
  postedReferences.add(key)
  return true
}

function adaptPushEventCommits(commits) {
  return commits.map(({ id, ...commit }) => ({
    sha: id,
    commit,
  }))
}

async function getCommits() {
  const {
    organization: { login: owner },
    repository: { name: repo },
    before,
    after,
  } = payload
  core.info(`Getting commits from ${before} to ${after}`)
  const { data } = await octokit.rest.repos.compareCommits({
    owner,
    repo,
    base: before,
    head: after,
  })
  return data.commits
}

const commits =
  'commits' in payload
    ? adaptPushEventCommits(payload.commits)
    : await getCommits()

if (!commits?.length) {
  core.info('No commits found')
} else {
  core.info(`Commits: ${commits.length}`)
  const commitResults = await Promise.allSettled(
    commits.map(async (commitItem) => {
      const {
        sha,
        commit: { message, author: gitAuthor },
      } = commitItem
      core.debug(`Commit message:${`\n${message}`.replace('\n', '\n\t')}`)

      const urls =
        message.match(
          /https:\/\/github.com\/([^\s/]+\/){2}pull\/\d+#discussion_r\d+/gi
        ) || []

      core.debug(`Discussion URLs: ${urls.length}`)

      if (urls.length > 0) {
        const ghLogin = commitItem.author?.login ?? gitAuthor?.username
        const authorMarkdown = ghLogin
          ? // Link, not `@mention`, to avoid notifying the author each reference.
            `[@${ghLogin}](https://github.com/${ghLogin})`
          : (gitAuthor?.name ?? '_(unknown)_')

        const longestBacktickRun = Math.max(
          0,
          ...[...message.matchAll(/`+/g)].map((m) => m[0].length)
        )
        const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1))

        const replyResults = await Promise.allSettled(
          urls
            .map((url) => new URL(url))
            .map((url) => ({
              url,
              owner: url.pathname.split('/').at(1),
              repo: url.pathname.split('/').at(2),
              prNumber: Number(url.pathname.split('/').at(-1)),
              commentId: Number(url.hash.replace('#discussion_r', '')),
            }))
            .map(async ({ url, owner, repo, prNumber, commentId }) => {
              // A reference we fail to check is still worth posting: a
              // duplicate reply is an annoyance, a missing one is a lost link.
              let thread
              try {
                thread = await getThread({
                  owner,
                  repo,
                  prNumber,
                  commentId,
                })
              } catch (error) {
                core.error(
                  `Failed to read the thread of ${url.toString()}, replying without checking for duplicates: ${error}`
                )
              }

              if (isAlreadyReferenced(thread?.bodies ?? [], sha)) {
                core.info(
                  `Already referenced in ${url.toString()}, skipping reply`
                )
                return null
              }
              if (
                !claimReference({
                  owner,
                  repo,
                  prNumber,
                  threadId: thread?.id,
                  commentId,
                  sha,
                })
              ) {
                core.info(
                  `Thread of ${url.toString()} is referenced by this run already, skipping reply`
                )
                return null
              }

              core.info(`Posting reply to ${url.toString()}`)
              return octokit.rest.pulls.createReplyForReviewComment({
                owner,
                repo,
                pull_number: prNumber,
                comment_id: commentId,
                body: `Referenced in ${sha} by ${authorMarkdown}:\n\n${fence}\n${message}\n${fence}\n\n${marker(sha)}`,
              })
            })
        )

        replyResults.forEach((result, index) => {
          if (result.status === 'rejected') {
            core.error(
              `Failed to post reply to ${urls[index]}: ${result.reason}`
            )
          }
        })
      }
    })
  )

  commitResults.forEach((result, index) => {
    if (result.status === 'rejected') {
      core.error(
        `Failed to process commit ${commits[index].sha}: ${result.reason}`
      )
    }
  })
}
