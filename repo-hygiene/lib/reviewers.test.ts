import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseCodeowners } from './codeowners.ts'
import {
  splitReviewers,
  describeReviewers,
  formatReviewerHandles,
  chooseReviewers,
  requestReviewersOneByOne,
} from './reviewers.ts'
import { fakeLog } from './__fixtures__/log.ts'
import { createHttpError, fakeOctokit } from './__fixtures__/octokit.ts'

describe('splitReviewers', () => {
  it('separates users from teams and strips prefixes', () => {
    assert.deepEqual(splitReviewers(['@alice', '@org/devs', 'bob', '@org/']), {
      users: ['alice', 'bob'],
      teams: ['devs'],
    })
  })

  it('deduplicates', () => {
    const users = Array.from({ length: 20 }, (_, i) => `@u${i}`)
    const result = splitReviewers([...users, '@u0', '@u1'])
    assert.equal(result.users.length, 20)
    assert.deepEqual(result.teams, [])
  })
})

describe('describeReviewers', () => {
  it('uses the singular, plural or empty form', () => {
    assert.equal(describeReviewers([]), 'no reviewer assigned')
    assert.equal(describeReviewers(['@a']), 'reviewer: @a')
    assert.equal(describeReviewers(['@a', '@org/t']), 'reviewers: @a, @org/t')
  })
})

describe('formatReviewerHandles', () => {
  it('prefixes users and teams', () => {
    assert.deepEqual(
      formatReviewerHandles('org', { users: ['a'], teams: ['devs'] }),
      ['@a', '@org/devs']
    )
  })
})

describe('chooseReviewers', () => {
  const octokit = () =>
    fakeOctokit({
      'repos.listContributors': () => [
        { type: 'User', login: 'alice' },
        { type: 'User', login: 'dependabot[bot]' },
        { type: 'User', login: 'renovate' },
        { type: 'Bot', login: 'bot' },
      ],
    })

  it('takes the suggestions when there are any', async () => {
    const result = await chooseReviewers(octokit(), {
      org: 'org',
      repo: 'r',
      suggested: ['@a', '@b'],
      parsedLines: parseCodeowners('/docs/ @writer'),
    })
    assert.deepEqual(result, {
      reviewerTokens: ['@a', '@b'],
      reviewerSource: 'codeowners-match',
    })
  })

  it('falls back to any CODEOWNERS owner', async () => {
    const result = await chooseReviewers(octokit(), {
      org: 'org',
      repo: 'r',
      suggested: [],
      parsedLines: parseCodeowners('/docs/ @writer @org/docs'),
    })
    assert.deepEqual(result, {
      reviewerTokens: ['@writer', '@org/docs'],
      reviewerSource: 'codeowners-fallback',
    })
  })

  it('falls back to human contributors', async () => {
    const result = await chooseReviewers(octokit(), {
      org: 'org',
      repo: 'r',
      suggested: [],
      parsedLines: [],
    })
    assert.deepEqual(result, {
      reviewerTokens: ['@alice'],
      reviewerSource: 'contributors',
    })
  })

  it('reports nobody when contributors are unavailable', async () => {
    for (const status of [204, 404]) {
      const result = await chooseReviewers(
        fakeOctokit({
          'repos.listContributors': () => {
            throw createHttpError(status)
          },
        }),
        { org: 'org', repo: 'r', suggested: [], parsedLines: [] }
      )
      assert.deepEqual(result, { reviewerTokens: [], reviewerSource: 'none' })
    }
  })

  it('rethrows other contributor errors', async () => {
    await assert.rejects(
      chooseReviewers(
        fakeOctokit({
          'repos.listContributors': () => {
            throw createHttpError(500)
          },
        }),
        { org: 'org', repo: 'r', suggested: [], parsedLines: [] }
      ),
      { status: 500 }
    )
  })
})

describe('requestReviewersOneByOne', () => {
  it('requests each reviewer separately and keeps going on failure', async () => {
    const octokit = fakeOctokit({
      'pulls.requestReviewers': ({ reviewers, team_reviewers: teams }) => {
        if (reviewers?.includes('gone') || teams?.includes('nope')) {
          throw createHttpError(
            422,
            'Reviews may only be requested from collaborators'
          )
        }
        return {}
      },
    })
    const log = fakeLog()
    const requested = await requestReviewersOneByOne(octokit, {
      org: 'org',
      repo: 'r',
      pullNumber: 3,
      users: ['alice', 'gone', 'bob'],
      teams: ['nope', 'devs'],
      log,
    })
    assert.deepEqual(requested, ['@alice', '@bob', '@org/devs'])
    assert.equal(octokit.calls.length, 5)
    assert.deepEqual(log.calls.warning, [
      'could not request reviewer @gone: Reviews may only be requested from collaborators',
      'could not request team reviewer @org/nope: Reviews may only be requested from collaborators',
    ])
    assert.deepEqual(octokit.calls[0].params, {
      owner: 'org',
      repo: 'r',
      pull_number: 3,
      reviewers: ['alice'],
    })
    assert.deepEqual(octokit.calls[4].params.team_reviewers, ['devs'])
  })

  it('caps accepted reviewers at 15 without counting invalid ones', async () => {
    const octokit = fakeOctokit({
      'pulls.requestReviewers': ({ reviewers }) => {
        if (reviewers?.[0] === 'gone') {
          throw createHttpError(422)
        }
        return {}
      },
    })
    const users = ['gone', ...Array.from({ length: 20 }, (_, i) => `u${i}`)]
    const requested = await requestReviewersOneByOne(octokit, {
      org: 'org',
      repo: 'r',
      pullNumber: 3,
      users,
      teams: ['devs'],
      log: fakeLog(),
    })
    assert.equal(requested.length, 15)
    assert.equal(requested[0], '@u0')
    assert.equal(requested[14], '@u14')
    assert.equal(octokit.calls.length, 16)
  })

  it('rethrows failures other than an invalid reviewer', async () => {
    const octokit = fakeOctokit({
      'pulls.requestReviewers': () => {
        throw createHttpError(403)
      },
    })
    await assert.rejects(
      requestReviewersOneByOne(octokit, {
        org: 'org',
        repo: 'r',
        pullNumber: 3,
        users: ['alice'],
        teams: [],
        log: fakeLog(),
      }),
      { status: 403 }
    )
  })
})
