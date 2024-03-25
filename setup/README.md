# `verkstedt/actions/setup`

Unified setup for Node.js projects.

- Check out the code
- Set up Node.js from `.nvmrc`
- Install packages (`npm` or `yarn`)
- Cache `node_modules`

You should have one `initial-setup` job that only calls this action and
then each other job `needs` your `initial-setup` job, but _also_
includes a step that uses `verkstedt/acitons/setup`.

This way all of the subsequent jobs _should_ use the cache warmed up in
the `initial-setup` job, but in case cache is pruned they will not fail.
