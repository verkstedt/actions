# Repo hygiene action

Check the hygiene of repos in an organisation and open PR fixing the
issues.

Current checks:

- Make sure there’s `.github/dependabot.yaml` with entries for things
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

The action is written in TypeScript. Tests run the sources directly
through Node’s type stripping, so only erasable syntax is allowed (no
enums, no parameter properties). Type checking is part of `npm run
lint` in the repository root.

```sh
npm install
npm test -w repo-hygiene
npm run lint
npm run build -w repo-hygiene
```

`dist/` is committed because GitHub Actions runs the action straight
from the repo without `npm install`. Always rebuild before committing
changes in the source code.
