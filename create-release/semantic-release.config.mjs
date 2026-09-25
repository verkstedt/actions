import assert from 'node:assert'
import fs from 'node:fs'

function unindent(text) {
  const textTrimLines = text.replaceAll(/(^\n+|\n+$)/g, '')
  const [indent] = textTrimLines.match(/^\s*/m)
  return textTrimLines.replaceAll(new RegExp(`^${indent}`, 'gm'), '')
}

/**
 * @type {import('semantic-release').GlobalConfig}
 */
const config = {
  // WARNING: Escaping here is tricky.
  // semantic-release interpolates some ${…} variables,
  // but because these shell commands are inside a JavaScript
  // string literals (so we can write them multi–line), we
  // have to escape $ in semantic-release (and shell
  // variables, if we use ${foo} not $foo) to avoid them
  // being expanded by JavaScript before semantic-release
  // sees them.
  plugins: [
    /// Read release type from environment variable, instead of
    // analysing commits
    [
      '@semantic-release/exec',
      {
        verifyConditionsCmd: unindent(`
          if [ -z "$RELEASE_TYPE" ]
          then
            echo "ERROR: RELEASE_TYPE environment needs to be set." 2>&1
            exit 64 # EX_USAGE
          fi
          if ! echo "major minor patch" | grep -wq "$RELEASE_TYPE"
          then
            echo "ERROR: RELEASE_TYPE must be one of: major, minor, patch." 2>&1
            exit 64 # EX_USAGE
          fi
        `),
        analyzeCommitsCmd: unindent(`
          echo "$RELEASE_TYPE"
        `),
      },
    ],

    // Use GitHub API to generate release notes
    [
      '@semantic-release/exec',
      {
        generateNotesCmd: unindent(`
          lastGitTag="\${lastRelease.gitTag}"
          set -- -f tag_name='\${nextRelease.gitTag}'
          if [ -n "$lastGitTag" ] && [ "$lastGitTag" != "null" ]
          then
            set -- "$@" -f previous_tag_name=$lastGitTag
          fi
          # Pin the lineage the notes are read from.
          # The tag does not exist yet at this point and without this it
          # would fall back to the repository's default branch — which is
          # wrong if tag is not there (i.e. hotfix).
          # semantic-release resolves its own branch from GITHUB_REF too, and
          # only gets here once that branch matched the release config, so
          # GITHUB_REF_NAME is that same branch — and needs no templating.
          if [ -n "$GITHUB_REF_NAME" ]
          then
            set -- "$@" -f target_commitish="$GITHUB_REF_NAME"
          fi
          # Note: We need to include name of the release,
          # because it will not be added to CHANGELOG otherwise.
          # Sad side–effect of this is that it’s also included
          # in GitHub release notes and git commit message, even
          # though it’s included as subject of these as well.
          gh api \
            -X POST \
            repos/:owner/:repo/releases/generate-notes \
            "$@" \
            --jq '"# " + .name + "\n\n" + .body'
        `),
      },
    ],

    // Update version in whichever of these files exist
    ...Object.entries({
      'version.txt': [
        '@semantic-release/exec',
        {
          prepareCmd: unindent(`
            echo "\${nextRelease.version}" > version.txt
          `),
        },
      ],

      'Cargo.toml': [
        '@semantic-release/exec',
        {
          // `[package]` and/or `[workspace.package]`, plus Cargo.lock
          // Function source ends up in a double–quoted shell string and is
          // interpolated by semantic-release, so it must not contain `"`,
          // `$` or backticks.
          prepareCmd: [
            'set -e\n',
            'node -e "(',
            async function bumpCargoVersion(version) {
              const { readFile, writeFile } = await import('node:fs/promises')
              const lines = (await readFile('Cargo.toml', 'utf8')).split('\n')
              let section = null
              const updatedSections = new Set()
              const newLines = lines.map((line) => {
                const trimmedLine = line.trim()
                if (trimmedLine.startsWith('[')) {
                  section = trimmedLine.replace(/#.*/, '').trim()
                }
                const isPackageSection =
                  section === '[package]' || section === '[workspace.package]'
                if (
                  isPackageSection &&
                  !updatedSections.has(section) &&
                  /^version\s*=\s*[\x22\x27]/.test(trimmedLine)
                ) {
                  updatedSections.add(section)
                  return line.replace(
                    /\x22[^\x22]*\x22|\x27[^\x27]*\x27/,
                    JSON.stringify(version)
                  )
                }
                return line
              })
              if (updatedSections.size === 0) {
                throw new Error(
                  'Cargo.toml: no version found in [package] or [workspace.package]'
                )
              }
              await writeFile('Cargo.toml', newLines.join('\n'))
            }.toString(),
            `)(process.argv[1])" "\${nextRelease.version}"\n`,
            unindent(`
              if [ -f Cargo.lock ]
              then
                cargo update --workspace --offline || cargo update --workspace
              fi
            `),
          ].join(''),
        },
      ],

      'package.json': [
        '@semantic-release/npm',
        {
          // Do not publish to npm registry, just bump the version
          npmPublish: false,
        },
      ],
    })
      .filter(([path]) => fs.existsSync(path))
      .map(([, plugin]) => plugin),

    // Write release notes to CHANGELOG.md
    ['@semantic-release/changelog'],

    // Write release notes to GitHub Actions summary
    [
      '@semantic-release/exec',
      {
        verifyConditionsCmd: unindent(`
          if [ -z "$GITHUB_STEP_SUMMARY" ]
          then
            echo "ERROR: GITHUB_STEP_SUMMARY environment needs to be set." 2>&1
            exit 64 # EX_USAGE
          fi
        `),
        successCmd: unindent(`
          cat << 'STEP_SUMMARY' >> "$GITHUB_STEP_SUMMARY"
          \${nextRelease.notes}
          STEP_SUMMARY
        `),
      },
    ],

    // Write release notes to GitHub Actions output
    [
      '@semantic-release/exec',
      {
        verifyConditionsCmd: unindent(`
          if [ -z "$GITHUB_OUTPUT" ]
          then
            echo "ERROR: GITHUB_OUTPUT environment needs to be set." 2>&1
            exit 64 # EX_USAGE
          fi
        `),
        successCmd: unindent(`
          {
            echo 'release-notes<<RELEASE_NOTES_EOF'
            echo "\${nextRelease.notes}"
            echo 'RELEASE_NOTES_EOF'
          } | tee -a "$GITHUB_OUTPUT"
        `),
      },
    ],

    // Commit and push changed files
    [
      '@semantic-release/git',
      {
        assets: [
          'CHANGELOG.md',
          'package.json',
          'package-lock.json',
          'yarn.lock',
          'version.txt',
          'Cargo.toml',
          'Cargo.lock',
        ],
        message: unindent(`
          chore(release): \${nextRelease.version}

          \${nextRelease.notes}
        `),
      },
    ],

    // Register a GitHub release
    [
      '@semantic-release/github',
      {
        successComment: unindent(`
          :tada: This PR has been included in version **\${nextRelease.version}**

          <% _.forEach(releases, function(release) { if (release.url) { %>
          - [<%= release.name %>](<%= release.url %>)
          <% } } ); %>
        `),
      },
    ],
  ],
}

// Require all plugins to be specified as arrays to make it easier to
// extract them.
assert.equal(
  config.plugins.filter((plugin) => !Array.isArray(plugin)).length,
  0,
  "All semantic-release plugins MUST be specified as arrays, i.e. ['plugin-name'], instead of 'plugin-name'."
)

export default config
