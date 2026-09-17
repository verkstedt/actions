import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEPENDABOT_TEMPLATE,
  fakeOctokit,
  fakeSnapshot,
  fileResponse,
  httpError,
} from '../fixtures.ts'
import { dependabotConfig } from './dependabot-config.ts'

const templateOctokit = (content: string | null) =>
  fakeOctokit({
    'repos.getContent': ({ path }: { path: string }) => {
      if (content && path === 'templates/dependabot.yaml') {
        return fileResponse(path, content)
      }
      throw httpError(404)
    },
  })

describe('dependabotConfig', () => {
  it('fails setup when the org template is missing', async () => {
    await assert.rejects(dependabotConfig.setup!(templateOctokit(null)), {
      message: 'verkstedt/.github has no templates/dependabot.yaml',
    })
  })

  it('creates the file from the template for detected ecosystems', async () => {
    await dependabotConfig.setup!(templateOctokit(DEPENDABOT_TEMPLATE))
    const snapshot = await fakeSnapshot({
      paths: ['package.json', '.github/workflows/ci.yaml'],
    })
    const findings = await dependabotConfig.run(snapshot)
    assert.equal(findings.length, 1)
    const [finding] = findings
    assert.equal(finding.level, 'info')
    assert.equal(finding.summary, 'dependabot config missing')
    assert.equal(finding.fix?.kind, 'file')
    if (finding.fix?.kind !== 'file') throw new Error('expected file fix')
    assert.equal(finding.fix.path, '.github/dependabot.yaml')
    assert.equal(finding.fix.lang, 'yaml')
    assert.match(finding.fix.content, /package-ecosystem: 'npm'/)
    assert.match(finding.fix.content, /package-ecosystem: 'github-actions'/)
    assert.doesNotMatch(finding.fix.content, /docker/)
    assert.equal(
      finding.fix.describe,
      'created `.github/dependabot.yaml` with sections: `npm`, `github-actions`'
    )
  })

  it('extends an existing .yml in place', async () => {
    await dependabotConfig.setup!(templateOctokit(DEPENDABOT_TEMPLATE))
    const snapshot = await fakeSnapshot({
      paths: ['package.json', 'Dockerfile'],
      files: {
        '.github/dependabot.yml':
          "version: 2\nupdates:\n  - package-ecosystem: 'npm'\n    directory: '/'\n    schedule:\n      interval: 'weekly'\n    cooldown:\n      default-days: 7\n",
      },
    })
    const [finding] = await dependabotConfig.run(snapshot)
    assert.equal(finding.summary, 'dependabot config incomplete')
    if (finding.fix?.kind !== 'file') throw new Error('expected file fix')
    assert.equal(finding.fix.path, '.github/dependabot.yml')
    assert.match(finding.fix.content, /package-ecosystem: 'docker'/)
    assert.equal(
      finding.fix.describe,
      'updated `.github/dependabot.yml`: added sections: `docker`'
    )
  })

  it('reports nothing to do when the config is complete', async () => {
    await dependabotConfig.setup!(templateOctokit(DEPENDABOT_TEMPLATE))
    const snapshot = await fakeSnapshot({
      paths: ['package.json'],
      files: { '.github/dependabot.yaml': DEPENDABOT_TEMPLATE },
    })
    assert.deepEqual(await dependabotConfig.run(snapshot), [
      { level: 'info', summary: 'dependabot config is complete' },
    ])
  })

  it('reports nothing to do for a repo without ecosystems', async () => {
    await dependabotConfig.setup!(templateOctokit(DEPENDABOT_TEMPLATE))
    const snapshot = await fakeSnapshot({ paths: ['README.md'] })
    assert.deepEqual(await dependabotConfig.run(snapshot), [
      { level: 'info', summary: 'dependabot config is complete' },
    ])
  })
})
