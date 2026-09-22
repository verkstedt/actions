# Repo hygiene action

Check the hygiene of repos in an organisation and open PR fixing the
issues.

The checks live in [`lib/checks/`](./lib/checks/), one file per check.
Each file starts with a description of what the check looks for and
how it fixes it.

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
npm install
npm test -w repo-hygiene
npm run lint
npm run build -w repo-hygiene
```

`dist/` is committed because GitHub Actions runs the action straight
from the repo without `npm install`. Always rebuild before committing
changes in the source code.

To see what the action would do without a workflow run, audit repos
from your machine as a dry run:

```sh
npx repo-hygiene --help
```
