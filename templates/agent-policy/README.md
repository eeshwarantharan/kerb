# Agent policy for Kerb

This repository holds your organisation's Kerb policy: the boundaries every coding agent should know before it tries something, and the approved alternatives.

## How it works

1. You edit `policy.json` and open a pull request. CI runs `kerb policy lint`.
2. On merge to `main`, CI signs the policy with your Ed25519 key and publishes `kerb-bundle.json`.
3. Each developer machine has a managed config (deployed by MDM) that points at the bundle URL and pins your public key. Kerb fetches the bundle at session start, verifies the signature, and caches it for up to 24 hours. An unverified bundle is never used.

## One-time setup

```bash
kerb policy keygen --out keys          # writes keys/kerb-org.key (secret) and keys/kerb-org.pub
```

- Store the contents of `keys/kerb-org.key` as the repository secret `ORG_POLICY_SIGNING_KEY`. Don't commit it.
- Store the public key (`keys/kerb-org.pub`) as the repository variable `ORG_POLICY_PUBLIC_KEY`.
- Replace the "Publish" step in `.github/workflows/publish.yml` with an upload to a host that serves ETags.
- Deploy the managed config with MDM:

| OS | Path |
|---|---|
| macOS | `/Library/Application Support/Kerb/managed.json` |
| Linux | `/etc/kerb/managed.json` |
| Windows | `%ProgramData%\Kerb\managed.json` |

```json
{
  "org": {
    "bundle_url": "https://policy.example.internal/kerb-bundle.json",
    "public_key": "<contents of kerb-org.pub>",
    "max_cache_hours": 24
  },
  "lock_repo_alternatives": true,
  "telemetry": { "otlp_endpoint": "https://otel.example.internal/v1/metrics" },
  "defaults": { "recap": "on" },
  "locked": ["telemetry"]
}
```

## Writing the policy

See section 4.8.2 of [KERB.md](https://github.com/kerb-dev/kerb/blob/main/docs/KERB.md) for every field. In short:

- `host`: a hostname glob; `*` matches one or more labels (`*.pypi.org` matches `files.pypi.org`, not `pypi.org`).
- `program`: blocks any command whose program is this (`docker` blocks `sudo docker run …`).
- `command`: a glob over the whole command (`terraform apply*`).
- `git_push`: a glob over the branch being pushed to (`main`, `release/*`).
- `alternative`: what to use instead. Kerb shows it to the agent; it never suggests other routes.

Name alternatives only for things you actually provide. A block without an alternative tells the agent to ask the user.

## Reviewing what agents hit

Developers (or your telemetry collector) export learned denials; you turn them into a proposed patch:

```bash
kerb export-denials --since 30d > denials-alice.jsonl     # on each machine
kerb review --denials denials-*.jsonl                     # here; keeps hosts seen on 3+ machines
```

`review` writes `policy.patch.json` and `review.md` with three choices per host: open it in the firewall, add an alternative, or confirm the block with a reason.

## Dry run locally

```bash
SIGNING_KEY_FILE=keys/kerb-org.key PUBLIC_KEY="$(cat keys/kerb-org.pub)" BUNDLE_VERSION=1 sh scripts/sign.sh
```
