# `verkstedt/actions/create-github-app-token`

Generate a GitHub App token if `app-id` and `private-key` inputs are
both provided. Falls back to `github.token`.

Example usage:

```yaml
- name: GitHub App token
  id: app-token
  uses: verkstedt/actions/create-github-app-token@v1
  with:
    app-id: ${{ vars.GH_AUTH_APP_ID }}
    private-key: ${{ secrets.GH_AUTH_APP_SECRET }}

- name: Setup
  uses: verkstedt/actions/setup@v1
  with:
    token: ${{ steps.app-token.outputs.token }}
```
