# RULES — how work is executed on this repository

## Execution environment

- **All build/test/tooling commands run on the remote VM, reached with
  `ssh maplibre`** (host `cka-ovh-dedicated-01`). The local workstation is for
  editing and git only — it deliberately has no node/npm toolchain.
- **Use containers, not direct commands.** Never invoke `node`, `npm`, `npx`,
  `python`, … straight on a host. The remote VM is **podman-ready** (podman ≥ 5
  with the compose provider; `docker compose` syntax works identically).
- **Rely on `docker-compose.yml` as the reference setup.** Every runnable
  concern (tests, demo preview) is a compose service; add new concerns as new
  services rather than ad-hoc commands.
- **Ports: stay inside the maplibre band (99xx).** The VM's platform layer
  (`debian:~/projects/platform/caddy/Caddyfile`) reserves a 127.0.0.1 port
  band per product; maplibre owns 99xx (9966 = maplibre-gl-js dev server,
  9967 = this repo's demo preview). Never bind 80xx/82xx/83xx/84xx ports —
  they belong to other products behind the shared edge.

The repo's home on the VM is
`~/projects/maplibre-gl-js/maplibre-plugin-photosphere` (next to the
maplibre-gl-js checkout it plugs into).

```sh
# sync the working tree to the VM, then run the suite there:
rsync -a --delete --exclude node_modules --exclude .git \
    ./ maplibre:projects/maplibre-gl-js/maplibre-plugin-photosphere/
ssh maplibre 'cd ~/projects/maplibre-gl-js/maplibre-plugin-photosphere && podman compose run --rm test'

# preview the GitHub Pages demo (serves the repo root, as Pages does):
ssh maplibre 'cd ~/projects/maplibre-gl-js/maplibre-plugin-photosphere && podman compose up -d web'   # 127.0.0.1:9967 (maplibre band 99xx)
```

## Deployment

- **GitHub Pages** serves the demo from the `main` branch root
  (`index.html` → `docs/`): every push to `main` deploys it.
- **Releases are driven the maplibre-gl-js way**, through
  [maplibre/reusable-workflows](https://github.com/maplibre/reusable-workflows):
  1. Land changes on `main` with notes under the `## main` section of
     CHANGELOG.md.
  2. Run the **"Create bump version PR"** workflow (choose major/minor/patch);
     it bumps package.json and renames `## main` → `## X.Y.Z` in a PR.
  3. Merge the PR: `release.yml` detects the version change and does the rest —
     vitest gate, **npm publish** (trusted publishing/OIDC, no tokens), the
     `vX.Y.Z` **tag**, provenance attestation, and the **GitHub Release** whose
     notes are the `## X.Y.Z` changelog section.
- **Never push tags manually** — the workflow creates them. Keep changelog
  version headers exactly `## X.Y.Z` (release-notes extraction matches them).

## Conventions

- **After every finished action, suggest the next GitHub issue/PR to work
  on** — pick from the open issues/PRs across maplibre-gl-photosphere,
  maplibre-gl-panoramax and mapmax, and say why it is next.
- **Don't prompt when the only answers are yes / "yes, allow script
  execution" / no** — the default is yes, and yes on executing scripts.
  Prompt only when the choice offers answers beyond those (a real decision
  between alternatives).
- Features are additive; keep the existing API intact (see CHANGELOG.md).
- `src/` ships as-is (no build step): plain ES modules, no TypeScript syntax.
- Pure logic that tests need (e.g. `src/tiles.js`) lives in its own module,
  importable without a WebGL or maplibre-gl context.
