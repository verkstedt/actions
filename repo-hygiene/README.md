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

## Adding a check

A check is one module in `lib/checks/` exporting a `Check`: a `name`,
`opensPr: true` when it may change files or needs the hygiene PR, an
optional `setup` for org-wide input, and `run(snapshot)` returning
findings. A finding is a
`level`, a `summary` and optionally a `url`, `details`, suggested
`reviewers` for the hygiene PR and a `fix`: either a whole file for
the PR or an action to perform. Add the export to the `checks` list in
`index.ts`; order matters when checks build on each other’s files.
Reporting, dry runs and Slack need no changes. See the design in
`docs/superpowers/specs/2026-09-17-repo-hygiene-findings-design.md`.

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
