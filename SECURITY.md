# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) on this repository. Don't open a public issue. We aim to acknowledge reports within two working days and to agree on a disclosure date with you.

Useful details: the Kerb version (`kerb --version`), how Kerb was installed (binary, Homebrew, npm), the agent, and the smallest reproduction you have.

## What Kerb is, and isn't

Kerb is a guard against wasted agent turns. It is **not** a security boundary against a hostile agent: an agent with shell access can edit `.kerb/` or `kerb.policy.json`, or run commands in ways Kerb can't see. Your firewall, egress proxy and platform permissions remain the enforcement. Tools built for command security, such as GuardRail, can run alongside Kerb.

Within that scope, these properties are security-relevant and we treat breaking them as vulnerabilities:

| Property | How Kerb keeps it |
|---|---|
| Deny-only | Hooks never return an allow or approve decision and never rewrite commands. A final filter strips any allow-type field from hook output. |
| No agent-controlled bypass | No flag or variable disables the Loopbreaker. Hooks refuse `kerb ack`, `reset`, `forget`, `config`, `uninstall`, `run --force`, `KERB_*` assignments, and running Kerb through `script`, `expect` or `unbuffer`. Human-only actions need a code typed on `/dev/tty` (`CONIN$` on Windows). |
| Fail open | Any internal error or a timeout in a hook allows the call, is logged to `~/.kerb/errors.log`, and is counted. |
| Signed org policy | Org bundles are verified with Ed25519 against a key pinned by the managed config; unverified bundles are never used, and a failed fetch keeps the last verified bundle. |
| Hostile repo policy | Alternatives named by a repo policy are shown as "from repo policy" and are ignored entirely when the managed config sets `lock_repo_alternatives`. Repo policy can add blocks but never remove or loosen an org block. |
| Prompt injection | Learning a wall needs a network-capable command, a denial line that names a host the command contacted, and it expires. Suspected walls never block. |
| Regex denial of service | Policy patterns are limited to 200 characters and 50 per list, and are applied only to lines up to 4 KB. |
| Secrets in logs | Logs and recorded commands are redacted as they stream (AWS, GitHub, Slack, OpenAI/Anthropic keys, JWTs, private keys, bearer tokens, URL credentials, `password=`-style values). State files are `0600` in `0700` directories; logs are evicted past 200 MB. |
| Network | Only `org.bundle_url` and `telemetry.otlp_endpoint`, and only when configured. A test enforces that no other code path imports a network module or calls `fetch`. |
| Supply chain | Zero runtime and dev dependencies (enforced in CI), npm releases with provenance, SHA-256 checksums and build-provenance attestations for every binary, a CycloneDX SBOM per release. |

## Supported versions

Security fixes go to the latest minor release.
