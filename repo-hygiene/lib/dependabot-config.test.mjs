import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseDependabotTemplate,
  loadDependabotTemplate,
  detectEcosystems,
  planDependabotChange,
} from './dependabot-config.mjs'
import {
  fakeOctokit,
  createFileResponse,
  createHttpError,
  fakeLog,
  DEPENDABOT_TEMPLATE,
} from './fixtures.mjs'

describe('parseDependabotTemplate', () => {
  it('indexes the entries by ecosystem', () => {
    const template = parseDependabotTemplate(DEPENDABOT_TEMPLATE)
    assert.deepEqual(
      [...template.entryByEcosystem.keys()],
      ['npm', 'docker', 'github-actions']
    )
    assert.equal(template.doc.get('version'), 2)
  })
})

describe('loadDependabotTemplate', () => {
  it('fetches the template from the org .github repo', async () => {
    const octokit = fakeOctokit({
      'repos.getContent': () =>
        createFileResponse('templates/dependabot.yaml', DEPENDABOT_TEMPLATE),
    })
    const template = await loadDependabotTemplate(octokit)
    assert.deepEqual(octokit.calls[0].params, {
      owner: 'verkstedt',
      repo: '.github',
      path: 'templates/dependabot.yaml',
    })
    assert.equal(template.entryByEcosystem.size, 3)
  })

  it('fails when the template is missing', async () => {
    const octokit = fakeOctokit({
      'repos.getContent': () => {
        throw createHttpError(404)
      },
    })
    await assert.rejects(loadDependabotTemplate(octokit), {
      message: /templates\/dependabot\.yaml/,
    })
  })
})

describe('detectEcosystems', () => {
  it('finds nothing in an empty tree', () => {
    assert.deepEqual(detectEcosystems([]), {
      detected: new Set(),
      requiredCodeowners: [],
    })
  })

  it('requires an owner only for lockfiles that exist', () => {
    const { detected, requiredCodeowners } = detectEcosystems([
      '/package.json',
      '/packages/a/package.json',
      '/packages/a/pnpm-lock.yaml',
    ])
    assert.deepEqual([...detected], ['npm'])
    assert.deepEqual(requiredCodeowners, ['pnpm-lock.yaml'])
  })

  it('detects docker, compose files, devcontainers and workflows', () => {
    const { detected, requiredCodeowners } = detectEcosystems([
      '/Dockerfile',
      '/images/base.Dockerfile',
      '/Dockerfile.worker',
      '/services/Dockerfile.worker',
      '/Containerfile',
      '/docker-compose.yml',
      '/deploy/docker-compose.prod.yaml',
      '/deploy/docker-compose.yml',
      '/.devcontainer/devcontainer.json',
      '/.github/workflows/ci.yaml',
    ])
    assert.deepEqual(
      [...detected],
      ['docker', 'docker-compose', 'devcontainers', 'github-actions']
    )
    assert.deepEqual(requiredCodeowners, [
      'Containerfile',
      'Dockerfile',
      'Dockerfile.worker',
      'base.Dockerfile',
      'docker-compose.prod.yaml',
      'docker-compose.yml',
      '/.devcontainer/devcontainer.json',
      '/.github/workflows/',
    ])
  })
})

describe('planDependabotChange', () => {
  const template = parseDependabotTemplate(DEPENDABOT_TEMPLATE)
  const log = fakeLog()
  const warnings = log.calls.warning

  it('does nothing when no ecosystem was detected', () => {
    const change = planDependabotChange({
      detected: new Set(),
      existing: null,
      template,
      log,
    })
    assert.equal(change, null)
  })

  it('creates a config from the template with only detected ecosystems', () => {
    const change = planDependabotChange({
      detected: new Set(['npm']),
      existing: null,
      template,
      log,
    })
    assert.equal(change.path, '.github/dependabot.yaml')
    assert.equal(change.sha, undefined)
    assert.match(change.newContent, /^# Org template\n/)
    assert.match(
      change.newContent,
      /# JavaScript\n\s+- package-ecosystem: 'npm'/
    )
    assert.doesNotMatch(change.newContent, /docker|github-actions/)
    assert.equal(
      change.summary,
      'created `.github/dependabot.yaml` with sections: `npm`'
    )
  })

  it('does nothing for an unknown ecosystem with no file', () => {
    const change = planDependabotChange({
      detected: new Set(['devcontainers']),
      existing: null,
      template,
      log,
    })
    assert.equal(change, null)
  })

  it('adds missing ecosystems and a cooldown, matching the quote style', () => {
    const existing = {
      path: '.github/dependabot.yml',
      sha: 'old',
      content: [
        'version: 2',
        'updates:',
        '  - package-ecosystem: "npm"',
        '    directory: "/"',
        '    schedule:',
        '      interval: "daily"',
        '    cooldown:',
        '      default-days: 3',
        '',
      ].join('\n'),
    }
    const change = planDependabotChange({
      detected: new Set(['npm', 'docker']),
      existing,
      template,
      log,
    })
    assert.equal(change.path, '.github/dependabot.yml')
    assert.equal(change.sha, 'old')
    assert.match(change.newContent, /interval: "daily"/)
    assert.match(change.newContent, /default-days: 7/)
    assert.match(change.newContent, /package-ecosystem: "docker"/)
    assert.doesNotMatch(change.newContent, /'/)
    assert.equal(
      change.summary,
      'updated `.github/dependabot.yml`: added sections: `docker`; set `cooldown.default-days: 7` on `npm`'
    )
  })

  it('leaves a complete config alone', () => {
    const change = planDependabotChange({
      detected: new Set(['npm', 'docker']),
      existing: { path: 'x', sha: 's', content: DEPENDABOT_TEMPLATE },
      template,
      log,
    })
    assert.equal(change, null)
  })

  it('adds an updates list to a file without one', () => {
    const change = planDependabotChange({
      detected: new Set(['npm']),
      existing: { path: 'x', sha: 's', content: 'version: 2\n' },
      template,
      log,
    })
    assert.match(change.newContent, /^version: 2\nupdates:\n/)
    assert.match(change.newContent, /package-ecosystem: 'npm'/)
    assert.equal(change.summary, 'updated `x`: added sections: `npm`')
  })

  it('adds a missing version to an otherwise complete file', () => {
    const change = planDependabotChange({
      detected: new Set(['npm', 'docker']),
      existing: {
        path: 'x',
        sha: 's',
        content: DEPENDABOT_TEMPLATE.replace(/^version: 2\n/m, ''),
      },
      template,
      log,
    })
    assert.match(change.newContent, /^version: 2\n/m)
    assert.equal(change.summary, 'updated `x`: set `version: 2`')
  })

  it('warns and skips a file whose updates is not a list', () => {
    const warningsBefore = warnings.length
    const change = planDependabotChange({
      detected: new Set(['npm']),
      existing: {
        path: 'x',
        sha: 's',
        content: 'version: 2\nupdates:\n  package-ecosystem: npm\n',
      },
      template,
      log,
    })
    assert.equal(change, null)
    assert.equal(warnings.length, warningsBefore + 1)
    assert.match(warnings.at(-1), /non-list `updates`/)
  })

  it('warns and skips an unparseable file', () => {
    const warningsBefore = warnings.length
    const change = planDependabotChange({
      detected: new Set(['npm']),
      existing: { path: 'x', sha: 's', content: 'version: [\n' },
      template,
      log,
    })
    assert.equal(change, null)
    assert.equal(warnings.length, warningsBefore + 1)
    assert.match(warnings.at(-1), /could not parse existing dependabot file/)
  })
})
