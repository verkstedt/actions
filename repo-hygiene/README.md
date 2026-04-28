# Repo hygiene action

Check the hygiene of repos in an organisation and open PR fixing the
issues.

Current checks:

- Make sure there’s `.github/dependaboy.yaml` with entries for things
  that are used in the repo and `CODEOWNERS` set up in a way that will
  make dependabot PRs get reviewers

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
npm run build
```

`dist/` is committed because GitHub Actions runs the action straight
from the repo without `npm install`. Always rebuild before committing
changes to `index.mjs`.
