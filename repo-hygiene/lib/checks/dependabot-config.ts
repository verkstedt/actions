/**
 * Makes sure `.github/dependabot.yaml`:
 *
 * - exists
 * - has an entry for every package ecosystem the repo uses
 * - has a `version`
 * - has a cooldown
 *
 * Entries are built from the org-wide template in `verkstedt/.github`
 * and written in the hygiene PR.
 */

import {
  detectEcosystems,
  loadDependabotTemplate,
  planDependabotChange,
} from '../dependabot-config.ts'
import type { Check, DependabotTemplate } from '../types.ts'

/** Where dependabot looks for its config, in order of precedence. */
const DEPENDABOT_PATHS = ['.github/dependabot.yaml', '.github/dependabot.yml']

let template: DependabotTemplate | null = null

function requireLoadedTemplate(): DependabotTemplate {
  if (!template) {
    throw new Error('dependabot-config check used before setup')
  }
  return template
}

/**
 * Every repo with a detected ecosystem has a dependabot config with an
 * entry for each, a `version` and a cooldown, built from the org-wide
 * template in `verkstedt/.github`.
 */
export const dependabotConfig: Check = {
  name: 'dependabot-config',
  opensPr: true,
  setup: async (octokit) => {
    template = await loadDependabotTemplate(octokit)
  },
  run: async (snapshot) => {
    const { detected } = detectEcosystems(await snapshot.listPaths())
    const existing = await snapshot.readFirstExistingFile(DEPENDABOT_PATHS)
    const change = planDependabotChange({
      detected,
      existing,
      template: requireLoadedTemplate(),
      log: snapshot.log,
    })
    if (!change) {
      return [{ level: 'info', summary: 'dependabot config is complete' }]
    }
    return [
      {
        level: 'info',
        summary: existing
          ? 'dependabot config incomplete'
          : 'dependabot config missing',
        fix: {
          kind: 'file',
          path: change.path,
          content: change.newContent,
          lang: 'yaml',
          describe: change.summary,
        },
      },
    ]
  },
}
