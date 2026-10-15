# Harness

Checks for `supernote.ts`, the one module with real logic that does not need
Obsidian. There is still no test framework; this is an `assert` script run
through esbuild, exactly as `CLAUDE.md` describes.

```bash
npx esbuild harness/supernote.ts --bundle --platform=node --format=cjs \
  --outfile=/tmp/h.cjs --log-level=error && node /tmp/h.cjs
```

It reads the real Partner-app mirror, so it needs one sync to have happened and
`supernote-tool` to be installed. It cross-checks the planned file count against
`find`, so a walk that silently loses files fails.
