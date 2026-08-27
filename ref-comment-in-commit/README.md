# `verkstedt/ref-comment-in-commit`

When a GH commit URL is included in commit message, link the commit from said comment.

Usage:

```yaml
name: 'Ref comments by commit'

on:
  push:

jobs:
  ref-comments:
    runs-on: ubuntu-latest
    steps:
      - uses: 'verkstedt/actions/ref-comment-in-commit@v1'
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
```

Each reply carries a hidden `<!-- verkstedt/ref-comment-in-commit/<sha> -->`
marker. Before replying, the thread is checked for that marker, so a commit
that gets pushed again — a force–push, or the same commit landing in every
branch of a PR stack — is only ever referenced once per thread.

## Building

> [!NOTE]
> Don’t forget to build before pushing.

```sh
npm run build
```

## TODO

- [ ] Error handling
- [ ] Strip comments when building. Currently our git hooks are not happy with the build file (loads of `TODO` comments and ugly spaces).
