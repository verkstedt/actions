import { tryGetContent } from './github.ts'
import type {
  FileContent,
  Logger,
  Octokit,
  PullRequest,
  RepoMeta,
  Snapshot,
} from './types.ts'

/** Pending file fixes and the paths the current check has read. */
export interface WorkingCopy {
  pending: Map<string, string>
  reads: Set<string>
  attach: (path: string, content: string) => void
  startCheck: () => void
}

export interface RepoSnapshot extends Snapshot {
  workingCopy: WorkingCopy
}

/** `fn` called at most once; later calls share the first promise. */
function memoise<T>(fn: () => Promise<T>): () => Promise<T> {
  let result: Promise<T> | undefined
  return () => {
    result ??= fn()
    return result
  }
}

function stripLeadingSlash(path: string): string {
  return path.replace(/^\//, '')
}

/**
 * The repo as one run sees it: head SHA fetched now, everything else
 * fetched once on first use and pinned to that SHA. `readFile` and
 * `readFirstFile` see file fixes attached by earlier checks and
 * record what they read; `readFileOnDefaultBranch` does neither.
 */
export async function takeSnapshot(
  octokit: Octokit,
  repoMeta: RepoMeta,
  { org, log }: { org: string; log: Logger }
): Promise<RepoSnapshot> {
  const repo = repoMeta.name
  const defaultBranch = repoMeta.default_branch
  const ref = await octokit.rest.git.getRef({
    owner: org,
    repo,
    ref: `heads/${defaultBranch}`,
  })
  const headSha = ref.data.object.sha

  const committed = new Map<string, Promise<FileContent | null>>()
  const readFileOnDefaultBranch = (rawPath: string) => {
    const path = stripLeadingSlash(rawPath)
    let file = committed.get(path)
    if (!file) {
      file = tryGetContent(octokit, {
        owner: org,
        repo,
        paths: [path],
        ref: headSha,
      })
      committed.set(path, file)
    }
    return file
  }

  const workingCopy: WorkingCopy = {
    pending: new Map(),
    reads: new Set(),
    attach: (path, content) => {
      workingCopy.pending.set(stripLeadingSlash(path), content)
    },
    startCheck: () => {
      workingCopy.reads.clear()
    },
  }

  const readFile = async (rawPath: string) => {
    const path = stripLeadingSlash(rawPath)
    workingCopy.reads.add(path)
    const file = await readFileOnDefaultBranch(path)
    const content = workingCopy.pending.get(path)
    if (content === undefined) return file
    return { path, sha: file?.sha, content }
  }

  const readFirstFile = async (paths: Array<string>) => {
    for (const path of paths) {
      const file = await readFile(path)
      if (file) return file
    }
    return null
  }

  const treePaths = memoise(async () => {
    const commit = await octokit.rest.git.getCommit({
      owner: org,
      repo,
      commit_sha: headSha,
    })
    const tree = await octokit.rest.git.getTree({
      owner: org,
      repo,
      tree_sha: commit.data.tree.sha,
      recursive: '1',
    })
    if (tree.data.truncated) {
      log.warning('tree response truncated; detection may be incomplete')
    }
    return (tree.data.tree || []).map((entry) => `/${entry.path}`)
  })
  const listPaths = async () => {
    const paths = await treePaths()
    const created = [...workingCopy.pending.keys()]
      .map((path) => `/${path}`)
      .filter((path) => !paths.includes(path))
    return [...paths, ...created]
  }

  const listOpenPrs = memoise((): Promise<Array<PullRequest>> =>
    octokit.paginate(octokit.rest.pulls.list, {
      owner: org,
      repo,
      state: 'open',
      per_page: 100,
    })
  )

  return {
    org,
    repo,
    defaultBranch,
    headSha,
    listPaths,
    readFile,
    readFirstFile,
    readFileOnDefaultBranch,
    listOpenPrs,
    octokit,
    log,
    workingCopy,
  }
}
