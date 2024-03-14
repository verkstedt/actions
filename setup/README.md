# `verkstedt/actions/setup`

Unified setup for Node.js projects.

- Check out the code
- Set up Node.js from `.nvmrc`
- Install packages (`npm` or `yarn`)

Uses cache, so it’s safe to use this multiple times in your workflow.
Usually you’d have one `setup` job that only calls this action and then
each other job `needs` your `setup` job, but also includes this action.

This way all of the subsequent jobs _should_ use the cache warmed up in
the `setup` job, but in case cache is pruned they will not fail.
