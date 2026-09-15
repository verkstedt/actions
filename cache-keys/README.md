# `verkstedt/actions/cache-keys`

Example usage:

```yaml
- name: Calculate cache key parts
  id: cache-keys
  uses: verkstedt/actions/cache-keys@v1

- name: Restore cache
  id: cache
  uses: actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
  with:
    path: |
      ./some-directory/
    key: |
      something--${{ steps.cache-keys.outputs.os }}--${{ steps.cache-keys.outputs.node }}--${{ steps.cache-keys.outputs.packageJson }}--${{ steps.cache-keys.outputs.packageJsonLock }}
    restore-keys: |
      something--${{ steps.cache-keys.outputs.os }}--${{ steps.cache-keys.outputs.node }}--${{ steps.cache-keys.outputs.packageJson }}--
      something--${{ steps.cache-keys.outputs.os }}--${{ steps.cache-keys.outputs.node }}--
```
