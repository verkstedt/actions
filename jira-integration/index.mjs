import * as core from '@actions/core'
import * as github from '@actions/github'

// Use these for local debugging.
// You will also need `mock-inputs.json` with input values.
//
// import * as mock from './mock.mjs'
//
// const core = mock
// const github = mock

const {
  context,
  context: { payload },
} = github
const pr = payload.pull_request || payload.issue

const githubToken = core.getInput('github-token')
const githubRequireKeywordPrefix =
  core.getInput('github-require-keyword-prefix') !== 'false'

const jiraDomainInput = core.getInput('jira-domain', { required: true })
const jiraUser = core.getInput('jira-user', { required: true })
const jiraApiToken = core.getInput('jira-api-token', { required: true })
const jiraStatusPrDraft = core.getInput('jira-status-pr-draft')
const jiraStatusPrReady = core.getInput('jira-status-pr-ready')
const jiraStatusPrMerged = core.getInput('jira-status-pr-merged')

const timeoutMs = 10_000

const authHeader = `Basic ${Buffer.from(`${jiraUser}:${jiraApiToken}`).toString('base64')}`

/**
 * @param {URL} baseUrl
 */
function createJiraClient(baseUrl) {
  async function request(method, path, { params, body } = {}) {
    const url = new URL(path, baseUrl)
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value)
      }
    }
    const response = await fetch(url, {
      method,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': authHeader,
      },
      body: body == null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const responseText = await response.text()
    const data = responseText ? JSON.parse(responseText) : undefined
    if (!response.ok) {
      core.error(
        `Error ${response.status} ${response.statusText} ${url.pathname}`
      )
      if (data !== undefined) {
        core.error(JSON.stringify(data))
      }
      throw new Error(
        `Jira request failed: ${method} ${url.pathname} → ${response.status} ${response.statusText}`
      )
    }
    return { data }
  }

  return {
    get: (path, options) => request('GET', path, options),
    post: (path, body) => request('POST', path, { body }),
    put: (path, body) => request('PUT', path, { body }),
  }
}

// https://developer.atlassian.com/cloud/jira/platform/rest/v3/
const jiraApiBaseUrl = new URL('/rest/api/3/', `https://${jiraDomainInput}`)
const jiraApi = createJiraClient(jiraApiBaseUrl)

// https://developer.atlassian.com/cloud/jira/software/rest/
const jiraAgileApiBaseUrl = new URL(
  '/rest/agile/1.0/',
  `https://${jiraDomainInput}`
)
const jiraAgileApi = createJiraClient(jiraAgileApiBaseUrl)

const octokit = github.getOctokit(githubToken)
const repoOwner = (payload.organization || payload.repository.owner).login
const issueNumber = (payload.pull_request || payload.issue).number

const tipCommentMarker = '<!-- JIRA_INTEGRATION_NAG -->'

/**
 * GitHub data
 *
 * @typedef {object} PullRequestComment
 * @property {string} id
 * @property {string} body
 * @property {boolean} isMinimized
 */

/**
 * Jira data
 *
 * @typedef {string} IssueKey
 * @typedef {string} StatusName
 *
 * @typedef {object} IssueData
 * @property {string} issueKey
 * @property {StatusName} currentStatusName
 * @property {Map<StatusName, number>} availableTransitions
 */

/**
 * @param {string} name
 * @return {StatusName}
 */
function normaliseStatusName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * @param {Array<IssueKey>} issuesKeys
 * @return {Promise<Array<IssueData>>}
 */
async function getIssues(issuesKeys) {
  const response = await jiraApi.get('search/jql', {
    params: {
      maxResults: 100,
      jql: `id in (${issuesKeys.join(',')})`,
      fields: 'status',
      expand: 'transitions',
    },
  })

  return response.data.issues.map((jiraIssueData) => ({
    issueKey: jiraIssueData.key,
    currentStatusName: normaliseStatusName(jiraIssueData.fields.status.name),
    availableTransitions: new Map(
      jiraIssueData.transitions
        .filter((t) => t.isAvailable)
        .map((t) => [normaliseStatusName(t.name), Number.parseInt(t.id, 10)])
    ),
  }))
}

const keywords = [
  'closes',
  'close',
  'closed',
  'fix',
  'fixes',
  'fixed',
  'resolve',
  'resolves',
  'resolved',
]

/**
 * @param {string} prBody
 * @param {Array<PullRequestComment>} comments
 * @return {Array<IssueKey>}
 */
function extractResolvedIssueKeys(prBody, comments) {
  const text = [
    prBody,
    ...comments
      .filter((comment) => !comment.isMinimized)
      .map((comment) => comment.body),
  ].join('\0')

  const keywordsRegExp = githubRequireKeywordPrefix
    ? `(?:${keywords.join('|')})\\s+`
    : ''
  // Warning:
  // It’s extremely important for this regexp to match only simple
  // jira keys as extracted keys will be used in JQL queries.
  const issueKeyRegExp = '[A-Z][A-Z0-9]+-[0-9]+'
  const urlRegExp = `${jiraApiBaseUrl.origin}/browse/(${issueKeyRegExp})`
  const closesRegExp = `${keywordsRegExp}<?${urlRegExp}>?(?:\\s*,\\s*<?${urlRegExp}>?)*`

  // Find all “Closes URL, URL…”
  const matches = text.match(new RegExp(closesRegExp, 'gi')) || []

  return Array.from(
    new Set(
      matches.flatMap((match) => {
        // Find URLs
        const urlMatches = match.match(new RegExp(urlRegExp, 'gi'))
        // Find issueId in the URL (only capture group in urlRegExp)
        const issueKeys = urlMatches.map((url) =>
          url.match(new RegExp(urlRegExp, 'i'))[1].toUpperCase()
        )
        return issueKeys
      })
    )
  )
}

/**
 * @return {Promise<Array<PullRequestComment>>}
 */
async function getPullRequestComments() {
  core.info('Requesting pull request comments')

  const query = `
    query ($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        issueOrPullRequest(number: $number) {
          ... on Issue {
            comments(first: 100, after: $cursor) {
              nodes { id body isMinimized }
              pageInfo { hasNextPage endCursor }
            }
          }
          ... on PullRequest {
            comments(first: 100, after: $cursor) {
              nodes { id body isMinimized }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }
    }
  `

  const comments = []
  let cursor = null
  let hasNextPage = true
  while (hasNextPage) {
    const result = await octokit.graphql(query, {
      owner: repoOwner,
      repo: payload.repository.name,
      number: issueNumber,
      cursor,
    })
    const page = result.repository.issueOrPullRequest.comments
    comments.push(...page.nodes)
    hasNextPage = page.pageInfo.hasNextPage
    cursor = page.pageInfo.endCursor
  }
  return comments
}

/**
 * @param {Array<PullRequestComment>} tipComments
 * @return {Promise<void>}
 */
async function minimiseTipComments(tipComments) {
  if (tipComments.length === 0) return

  core.info('Issues found — minimising stale tip comment(s).')
  await Promise.all(
    tipComments.map(async (tip) => {
      try {
        await octokit.graphql(
          `mutation ($id: ID!) {
            minimizeComment(input: { subjectId: $id, classifier: RESOLVED }) {
              minimizedComment { isMinimized }
            }
          }`,
          { id: tip.id }
        )
      } catch (error) {
        core.error(`Failed to minimise tip comment: ${error}`)
      }
    })
  )
}

async function postTipCommentLinkJiraIssue(tipComments) {
  if (
    // Only post a comment, if acting upon an event that could’ve
    // changed PR body
    ['pull_request', 'pull_request_target'].includes(context.eventName) &&
    ['opened', 'edited'].includes(payload.action)
  ) {
    try {
      if (tipComments.length > 0) {
        core.info('No issues found, but tip comment already present.')
      } else {
        core.info('No issues found — posting a tip comment.')

        const keyword =
          keywords[0].slice(0, 1).toUpperCase() + keywords[0].slice(1)
        const body = `${tipCommentMarker}\n> [!TIP]\n> Include “${keyword} <var>JIRA_ISSUE_URL</var>” in the PR body to associate it with an issue.`

        await octokit.rest.issues.createComment({
          issue_number: pr.number,
          owner: repoOwner,
          repo: payload.repository.name,
          body,
        })
      }
    } catch (error) {
      core.error(`Failed to post tip comment: ${error}`)
    }
  }
}

/**
 * @param {Array<IssueKey>} issueKeys
 * @return {Promise<void>}
 */
async function assignPrToIssues(issueKeys) {
  await Promise.all(
    issueKeys.map(async (issueKey) => {
      core.info(`Assigning PR #${pr.number} to issue ${issueKey}`)

      const prLinkObject = {
        url: pr.html_url,
        // Using URL as title will make JIRA fetch the title itself
        title: pr.html_url,
        icon: { url16x16: 'https://github.com/favicon.ico' },
      }

      const { data: links } = await jiraApi.get(
        `issue/${encodeURIComponent(issueKey)}/remotelink`
      )

      const alreadyAssigned = links.some(
        (link) => link.object.url === prLinkObject.url
      )
      if (!alreadyAssigned) {
        await jiraApi.post(`issue/${encodeURIComponent(issueKey)}/remotelink`, {
          application: {},
          object: prLinkObject,
        })
      }
    })
  )

  core.info(`Assigned PR #${pr.number} to ${issueKeys.length} issue(s)`)
}

function escapeJqlString(str) {
  return str.replace(/(["\\])/g, '\\$1')
}

/**
 * @param {StatusName} statusName
 * @return {Promise<IssueKey|undefined>}
 */
async function getLastIssueInStatusKey(statusName) {
  const statusNameNormalised = normaliseStatusName(statusName)
  const response = await jiraApi.get('search/jql', {
    params: {
      maxResults: 1,
      jql: `status="${escapeJqlString(statusNameNormalised)}" ORDER BY Rank DESC`,
      fields: 'key',
    },
  })
  const key = response.data.issues.at(0)?.key
  core.info(`Last issue in ${statusName} is ${key}`)
  return key
}

/**
 * @param {Array<IssueKey>} issueKeys
 * @param {Array<StatusName>} newStatusNames
 * @return {Promise<void>}
 */
async function transitionIssues(issueKeys, newStatusNames) {
  const newStatusNamesNormalised = newStatusNames.map(normaliseStatusName)

  const issuesData = await getIssues(issueKeys)

  /** @type {Map<StatusName, Array<IssueData>}>} */
  const issuesByNewStatusName = new Map()
  issuesData.forEach((issueData) => {
    const newStatusName = newStatusNamesNormalised.find((statusName) =>
      issueData.availableTransitions.has(statusName)
    )
    if (!newStatusName) {
      throw new Error(
        `Failed to find a valid transition for issue ${issueData.issueKey}. Looked for statuses: ${newStatusNames.join(', ')}. Available transitions: ${Array.from(issueData.availableTransitions.keys()).join(', ')}`
      )
    }

    if (issuesByNewStatusName.has(newStatusName)) {
      issuesByNewStatusName.get(newStatusName).push(issueData)
    } else {
      issuesByNewStatusName.set(newStatusName, [issueData])
    }
  })

  await Promise.all(
    Array.from(issuesByNewStatusName.entries()).map(
      async ([newStatusName, issues]) => {
        const lastIssueInStatusKey =
          await getLastIssueInStatusKey(newStatusName)

        const transitionedIssueKeys = (
          await Promise.all(
            issues.map(async (issue) => {
              if (issue.currentStatusName === newStatusName) {
                core.info(
                  `Did not transition ${issue.issueKey} — already in ${newStatusName}`
                )
                return null
              } else {
                const newStatusId =
                  issue.availableTransitions.get(newStatusName)
                if (newStatusId == null) {
                  throw new Error(
                    `List name “${newStatusName}” not found in JIRA. Available statuses: ${Array.from(issue.availableTransitions.keys()).join(', ')}`
                  )
                }

                await jiraApi.post(
                  `issue/${encodeURIComponent(issue.issueKey)}/transitions`,
                  {
                    transition: {
                      id: newStatusId,
                    },
                  }
                )

                core.info(`Transitioned ${issue.issueKey} to ${newStatusName}`)

                return issue.issueKey
              }
            })
          )
        ).filter(Boolean)

        // Move all newly transitioned issues to the end of the list
        if (transitionedIssueKeys.length > 0 && lastIssueInStatusKey) {
          await jiraAgileApi.put('issue/rank', {
            issues: transitionedIssueKeys,
            rankAfterIssue: lastIssueInStatusKey,
          })
          core.info(
            `Moved issues to the end of column '${newStatusName}': ${transitionedIssueKeys.join(', ')}`
          )
        }
      }
    )
  )
}

/* eslint complexity: ["error", 20] -- TODO Refactor */
async function main() {
  try {
    const comments = await getPullRequestComments()
    const tipComments = comments.filter(
      (comment) =>
        !comment.isMinimized && comment.body?.includes(tipCommentMarker)
    )
    const issueIds = extractResolvedIssueKeys(pr.body, comments)

    if (!issueIds.length) {
      core.info('Could not find issue IDs')
      // Only post a tip comment when the PR body could have changed
      await postTipCommentLinkJiraIssue(tipComments)
      return
    }
    core.info('Found issue IDs:', issueIds.join(', '))

    await minimiseTipComments(tipComments)

    // Treat PRs with “draft” or “wip” in brackets at the start or
    // end of the titles like drafts. Useful for orgs on unpaid
    // plans which doesn’t support PR drafts.
    const titleDraftRegExp =
      /^(?:\s*[[(](?:wip|draft)[\])]\s+)|(?:\s+[[(](?:wip|draft)[\])]\s*)$/i
    const isRealDraft = pr.draft === true
    const isFauxDraft = Boolean(pr.title.match(titleDraftRegExp))
    const isDraft = isRealDraft || isFauxDraft

    await assignPrToIssues(issueIds)

    if (pr.state === 'open' && isDraft) {
      if (!jiraStatusPrDraft) {
        core.info(
          'No draft PR status name provided, skipping transitioning issues'
        )
      } else {
        await transitionIssues(issueIds, jiraStatusPrDraft.split('|'))
      }
    } else if (pr.state === 'open' && !isDraft) {
      if (!jiraStatusPrReady) {
        core.info(
          'No ready PR status name provided, skipping transitioning issues'
        )
      } else {
        await transitionIssues(issueIds, jiraStatusPrReady.split('|'))
      }
    } else if (pr.state === 'closed') {
      if (!jiraStatusPrMerged) {
        core.info(
          'No merged PR status name provided, skipping transitioning issues'
        )
      } else {
        await transitionIssues(issueIds, jiraStatusPrMerged.split('|'))
      }
    } else {
      let type = 'not draft'
      if (isFauxDraft) {
        type = 'faux draft'
      } else if (pr.draft) {
        type = 'draft'
      }
      core.info(
        `Skipping transitioning the issues: pr.state=${pr.state}, ${type}`
      )
    }
  } catch (error) {
    core.setFailed(error)
  }
}

main()
