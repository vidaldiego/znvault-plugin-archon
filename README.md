# @zincapp/znvault-plugin-archon

Archon deployment plugin for **zn-vault-agent** (agent side) and the **znvault
CLI** (operator side). It deploys the [archon-node](https://github.com/vidaldiego/archon-node)
control plane with a vault-native, key-less flow: diff-based file upload over
SSH-CA, Prisma migrations through a short-lived dynamic-secrets lease, a 1+R
canary on the API class with HAProxy drain, and service restart.

Dual entry:

- **Agent** (`.` → `dist/index.js`) — `createArchonPlugin(config)` mounts the
  Fastify routes zn-vault-agent serves under `/plugins/archon/*` (hash manifest,
  diff apply, service lifecycle, guarded reboot, quiesce passthrough).
- **CLI** (`./cli` → `dist/cli.js`) — the `znvault archon …` command set.

## Install

```bash
# operator machine (CLI plugin):
znvault plugin install @zincapp/znvault-plugin-archon

# each node (agent-side; node agents run with auto-update disabled):
sudo npm install -g @zincapp/znvault-plugin-archon@<version>
sudo systemctl restart zn-vault-agent
```

Peer: `@zincapp/zn-vault-agent`. Requires Node ≥ 20.

## CLI

```bash
znvault archon config create production --hosts … --root <checkout>   # then hand-edit the multi-class config
znvault archon config validate production
znvault archon deploy run production [--dry-run|--class …|--pre-only|--skip-migrations|--skip-drain]
znvault archon deploy hashes production                               # preview the diff, no changes
znvault archon restart --target <host>
znvault archon reboot  --target <host> --confirm <hostname>           # 409 if confirm != hostname or a deploy is open
znvault archon quiesce start|status|resume --target <host>
```

The config lives at `~/.znvault/archon/configs.json` (a flat `{ name: config }`
map). A `production` config has an `api` class (1+R canary + HAProxy `haproxy`
block) and a `workers` class (sequential, non-blocking), plus a `migration`
block with the dynamic-secrets `roleId`.

## Key behaviors

- **Service auto-detection.** `config.service` is optional; when omitted the
  agent detects the single installed `archon-*.service` on the host, so one
  shared fleet config works for api/worker/scheduler/backup nodes.
- **Writes as the app user.** Files are placed with `sudo install -o archon
  -g archon` (the app tree is `archon`-owned, not agent-writable); parents are
  created segment-by-segment with a symlink guard.
- **Restart after deploy.** A changed host is restarted (for serving nodes,
  while drained and before the health-gate) so the new code actually runs.
- **Tunneled lifecycle.** `restart`/`reboot`/`quiesce` open an SSH-CA tunnel to
  the loopback-bound agent (`127.0.0.1:9100`).

## Operator runbook

See the archon-node repo:
[`docs/runbooks/ZN_VAULT_ARCHON_DEPLOY.md`](https://github.com/vidaldiego/archon-node/blob/main/docs/runbooks/ZN_VAULT_ARCHON_DEPLOY.md).

## Development

```bash
npm ci
npm run build      # tsc → dist/ (agent index.js + CLI cli.js)
npm test           # vitest
npm run lint
```

Releases publish to npm with provenance via OIDC trusted publishing on a
`v*` tag push (`.github/workflows/publish.yml`).
