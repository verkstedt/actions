/* eslint import/no-unresolved: [2, { ignore: ['@actions/'] }] -- This script run in GitHub CI */

import * as core from '@actions/core'
import * as github from '@actions/github'

const { context = {} } = github
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
  await Promise.all(
    commits.map(async ({ sha, commit: { message } }) => {
      core.debug(`Commit message:${`\n${message}`.replace('\n', '\n\t')}`)

      const urls =
        message.match(
          /https:\/\/github.com\/([^\s/]+\/){2}pull\/\d+#discussion_r\d+/gi
        ) || []

      core.debug(`Discussion URLs: ${urls.length}`)

      await Promise.all(
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
            octokit.rest.pulls.createReplyForReviewComment({
              owner,
              repo,
              pull_number: prNumber,
              comment_id: commentId,
              body: `Referenced in ${sha}`,
            })
          })
      )
    })
  )
}
