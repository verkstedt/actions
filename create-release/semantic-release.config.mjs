import assert from 'node:assert'

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
          echo $RELEASE_TYPE
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
          if [ -n "$lastGitTag" ]
          then
            set -- "$@" -f previous_tag_name=$lastGitTag
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

    // Update version.txt, if it exists
    [
      '@semantic-release/exec',
      {
        prepareCmd: unindent(`
          if [ -f version.txt ]
          then
            echo "\${nextRelease.version}" > version.txt
          fi
        `),
      },
    ],

    // Update version package.json, do not publish to npm registry
    [
      '@semantic-release/npm',
      {
        npmPublish: false,
      },
    ],

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
          cat << 'STEP_SUMMARY' >> $GITHUB_STEP_SUMMARY
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
          } | tee -a $GITHUB_OUTPUT
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
          'version.txt',
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
