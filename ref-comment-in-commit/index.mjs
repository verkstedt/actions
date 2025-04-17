import * as core from '@actions/core'
import * as github from '@actions/github'

const context = github.context ?? {}
const { payload } = context

const token = core.getInput('token')

/**
 * @doc https://octokit.github.io/rest.js
 */
const octokit = github.getOctokit(token)

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
              core.info(`Posting reply to ${url.toString()}`)
              return octokit.rest.pulls.createReplyForReviewComment({
                owner,
                repo,
                pull_number: prNumber,
                comment_id: commentId,
                body: `Referenced in ${sha} by ${authorMarkdown}:\n\n${fence}\n${message}\n${fence}`,
              })
            })
        )

        replyResults.forEach((result, index) => {
          if (result.status === 'rejected') {
            core.warning(
              `Failed to post reply to ${urls[index]}: ${result.reason}`
            )
          }
        })
      }
    })
  )

  commitResults.forEach((result, index) => {
    if (result.status === 'rejected') {
      core.warning(
        `Failed to process commit ${commits[index].sha}: ${result.reason}`
      )
    }
  })
}
