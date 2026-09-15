# Repo hygiene action

Check the hygiene of repos in an organisation and open PR fixing the
issues.

Current checks:

- Make sure there’s `.github/dependabot.yaml` with entries for things
  that are used in the repo and `CODEOWNERS` set up in a way that will
  make dependabot PRs get reviewers
- Request reviewers on open Dependabot PRs that have none, using the
  owners the current `CODEOWNERS` names for the files they touch.
  GitHub only applies `CODEOWNERS` when a PR is opened or pushed to, so
  PRs opened before the file covered them stay reviewer-less otherwise.
  PRs whose files have no owner are only reported as a warning.

Usual approach is to create a dedicated repository in your organisation
(e.g. `repo-hygiene-runner`) with `on: schedule:` trigger that calls
this workflow.

## Inputs and Outputs

See [`action.yaml`](./action.yaml).

## Usage

Reusable workflow that wires everything together (App token, action,
Slack notification) lives at
[`.github/workflows/repo-hygiene.yaml`](../.github/workflows/repo-hygiene.yaml).

## Development

```sh
cd repo-hygiene
npm install
npm test
npm run build
```

`dist/` is committed because GitHub Actions runs the action straight
from the repo without `npm install`. Always rebuild before committing
changes in the source code.
