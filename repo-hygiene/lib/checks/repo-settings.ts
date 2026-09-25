/**
 * Keeps the repository settings tidy:
 *
 * - wiki off
 * - projects off
 * - issues off, unless the repo is public
 * - auto-merge on
 * - branches deleted once merged
 *
 * All differing settings are changed with one repository update; no PR
 * is involved.
 */

import type { Check, GitHub } from '../types.ts'

/** The settings `PATCH /repos/{owner}/{repo}` accepts that we care about. */
type Settings = Pick<
  GitHub.Repository,
  | 'has_wiki'
  | 'has_projects'
  | 'has_issues'
  | 'allow_auto_merge'
  | 'delete_branch_on_merge'
>

interface Wanted {
  setting: keyof Settings
  value: boolean
  describe: string
}

/**
 * Wikis and projects are never used, so they only add tabs. Issues
 * are kept on public repos, where outsiders report through them, and
 * switched off elsewhere. Auto-merge and deleting the branch after a
 * merge keep Dependabot PRs from piling up.
 */
function listWantedSettings(repository: GitHub.Repository): Array<Wanted> {
  const isPublic = repository.visibility
    ? repository.visibility === 'public'
    : !repository.private
  return [
    { setting: 'has_wiki', value: false, describe: 'disable the wiki' },
    { setting: 'has_projects', value: false, describe: 'disable projects' },
    ...(isPublic
      ? []
      : [
          {
            setting: 'has_issues' as const,
            value: false,
            describe: 'disable issues (not a public repo)',
          },
        ]),
    { setting: 'allow_auto_merge', value: true, describe: 'allow auto-merge' },
    {
      setting: 'delete_branch_on_merge',
      value: true,
      describe: 'delete branches once merged',
    },
  ]
}

/** Repository settings every repo should have; see `listWantedSettings`. */
export const repoSettings: Check = {
  name: 'repo-settings',
  run: async (snapshot) => {
    const repository = await snapshot.getRepository()
    const changes = listWantedSettings(repository).filter(
      ({ setting, value }) => repository[setting] !== value
    )
    if (changes.length === 0) {
      return [{ level: 'info', summary: 'repository settings are as wanted' }]
    }
    const describes = changes.map((c) => c.describe)
    return [
      {
        level: 'info',
        summary: 'repository settings differ from the wanted ones',
        details: describes,
        fix: {
          kind: 'action',
          describe: describes.join(', '),
          run: async (ctx) => {
            await ctx.octokit.rest.repos.update({
              owner: ctx.org,
              repo: ctx.repo,
              ...Object.fromEntries(changes.map((c) => [c.setting, c.value])),
            })
            return describes.join(', ')
          },
        },
      },
    ]
  },
}
