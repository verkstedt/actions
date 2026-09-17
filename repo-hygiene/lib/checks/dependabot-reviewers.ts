import { codeownersForFiles, parseCodeowners } from '../codeowners.ts'
import { errorMessage } from '../github.ts'
import {
  CODEOWNERS_PATHS,
  requestReviewersOneByOne,
  reviewerHandles,
  splitReviewers,
} from '../reviewers.ts'
import type {
  Check,
  CheckFinding,
  CodeownersLine,
  Octokit,
  PullRequest,
  Snapshot,
} from '../types.ts'

/**
 * Reviewers drop off `requested_reviewers` once they review, so an
 * empty list alone does not mean nobody was ever asked; see
 * `hasReviews`.
 */
function isReviewerless(pr: PullRequest): boolean {
  return (
    pr.user?.login === 'dependabot[bot]' &&
    (pr.requested_reviewers || []).length === 0 &&
    (pr.requested_teams || []).length === 0
  )
}

async function hasReviews(
  octokit: Octokit,
  { org, repo, pr }: { org: string; repo: string; pr: PullRequest }
): Promise<boolean> {
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner: org,
    repo,
    pull_number: pr.number,
    per_page: 100,
  })
  return reviews.length > 0
}

/** Files a PR touches, including the old names of renamed files. */
async function listPrFiles(
  octokit: Octokit,
  { org, repo, pr }: { org: string; repo: string; pr: PullRequest }
): Promise<Array<string>> {
  const changed = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner: org,
    repo,
    pull_number: pr.number,
    per_page: 100,
  })
  return changed.flatMap((f) =>
    [f.filename, f.previous_filename].filter(
      (name): name is string => typeof name === 'string' && name !== ''
    )
  )
}

async function readCommittedCodeowners(
  snapshot: Snapshot
): Promise<Array<CodeownersLine>> {
  for (const path of CODEOWNERS_PATHS) {
    const file = await snapshot.readFileOnDefaultBranch(path)
    if (file) return parseCodeowners(file.content)
  }
  return []
}

async function checkPr(
  snapshot: Snapshot,
  pr: PullRequest,
  codeowners: Array<CodeownersLine>
): Promise<CheckFinding | null> {
  const { octokit, org, repo } = snapshot
  if (await hasReviews(octokit, { org, repo, pr })) return null

  const files = await listPrFiles(octokit, { org, repo, pr })
  const ownerTokens = codeownersForFiles(files, codeowners).filter(
    // Emails are valid owners but cannot be requested as reviewers.
    (token) => token.startsWith('@')
  )
  const split = splitReviewers(ownerTokens)
  const wanted = reviewerHandles(org, split)
  if (wanted.length === 0) {
    return {
      level: 'warning',
      summary: 'Dependabot PR has no reviewers and CODEOWNERS names nobody',
      url: pr.html_url,
      details: files,
    }
  }
  return {
    level: 'info',
    summary: 'Dependabot PR has no reviewers',
    url: pr.html_url,
    fix: {
      kind: 'action',
      describe: `request ${wanted.join(', ')} as reviewers`,
      run: async (ctx) => {
        const requested = await requestReviewersOneByOne(ctx.octokit, {
          org: ctx.org,
          repo: ctx.repo,
          pullNumber: pr.number,
          users: split.users,
          teams: split.teams,
          log: ctx.log,
        })
        if (requested.length === 0) {
          return {
            fixed: false,
            detail: `none of ${wanted.join(', ')} could be requested`,
          }
        }
        return `requested ${requested.join(', ')}`
      },
    },
  }
}

/**
 * Dependabot PRs opened before CODEOWNERS covered their files never
 * get reviewers, because GitHub applies CODEOWNERS only when a PR is
 * opened or pushed to. Propose the owners the committed CODEOWNERS
 * names for the files each such PR touches.
 */
export const dependabotReviewers: Check = {
  name: 'Dependabot reviewers',
  run: async (snapshot) => {
    const prs = (await snapshot.listOpenPrs()).filter(isReviewerless)
    if (prs.length === 0) return []
    const codeowners = await readCommittedCodeowners(snapshot)
    const findings: Array<CheckFinding> = []
    for (const pr of prs) {
      try {
        const finding = await checkPr(snapshot, pr, codeowners)
        if (finding) findings.push(finding)
      } catch (e) {
        findings.push({
          level: 'error',
          summary: 'could not check reviewers of Dependabot PR',
          url: pr.html_url,
          details: [errorMessage(e)],
        })
      }
    }
    return findings
  },
}
