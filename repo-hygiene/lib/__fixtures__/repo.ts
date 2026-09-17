import {
  createFileResponse,
  createHttpError,
  fakeOctokit,
  type FakeOctokit,
  type Handler,
} from './octokit.ts'

export interface FakeRepoOptions {
  /** Tree paths without a leading `/`. */
  paths?: Array<string>
  /** Committed files, path → content. */
  files?: Record<string, string>
  openPrs?: Array<unknown>
  contributors?: Array<unknown>
  /** Extra or overriding handlers, keyed like `'pulls.listFiles'`. */
  handlers?: Record<string, Handler>
}

/**
 * An octokit for one repo: the given tree, files and open PRs, one
 * human contributor unless overridden, and PR creation that returns
 * PR 42. `handlers` win over the defaults.
 */
export function fakeRepo({
  paths = [],
  files = {},
  openPrs = [],
  contributors,
  handlers = {},
}: FakeRepoOptions = {}): FakeOctokit {
  return fakeOctokit({
    'pulls.list': () => openPrs,
    'git.getRef': () => ({ object: { sha: 'head' } }),
    'git.getCommit': () => ({ tree: { sha: 'tree' } }),
    'git.getTree': () => ({
      truncated: false,
      tree: paths.map((p) => ({ path: p })),
    }),
    'repos.getContent': ({ path }: { path: string }) => {
      if (path in files) {
        return createFileResponse(path, files[path])
      }
      throw createHttpError(404)
    },
    'repos.listContributors': () =>
      contributors ?? [{ type: 'User', login: 'alice' }],
    'git.createRef': () => ({}),
    'repos.createOrUpdateFileContents': () => ({}),
    'pulls.create': ({ body, head }: { body: string; head: string }) => ({
      number: 42,
      html_url: 'https://p/42',
      head: { sha: 'prhead', ref: head },
      body,
    }),
    'pulls.requestReviewers': () => ({}),
    'pulls.createReview': () => ({}),
    'pulls.listReviews': () => [],
    'pulls.listFiles': () => [],
    ...handlers,
  })
}
