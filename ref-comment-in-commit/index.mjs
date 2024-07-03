import * as core from '@actions/core'
import * as github from '@actions/github'

const { context = {} } = github
const { payload } = context

const token = core.getInput('token')

const octokit = github.getOctokit(token)

// Handle push event. Get list of commits from the push event payload
if (payload?.commits) {
  const { commits } = payload
  core.info(`Commits: ${commits.length}`)
  await Promise.all(
    commits.map(async ({ id, message }) => {
      core.info(`Commit: ${message}`)

      const urls =
        message.match(
          /https:\/\/github.com\/([^\s/]+\/){2}pull\/\d+#discussion_r\d+/gi
        ) || []

      await Promise.all(
        urls
          .map((url) => new URL(url))
          .map((url) => ({
            prNumber: Number(url.pathname.split('/').at(-1)),
            commentId: Number(url.hash.replace('#discussion_r', '')),
          }))
          .map(async ({ prNumber, commentId }) => {
            octokit.rest.pulls.createReplyForReviewComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              pull_number: prNumber,
              comment_id: commentId,
              body: `Referenced in ${id}`,
            })
          })
      )
    })
  )
}
