# Security policy

## Reporting a vulnerability

Please report security problems privately, by email to **security@buildit.social**, not in a public issue or pull request.

<!-- TODO(maintainers): confirm that security@buildit.social exists and is monitored before publishing. -->

Include what you can of:

- what the problem is and what an attacker could do with it;
- the version or commit of `buildit-mcp`, and the transport (stdio or HTTP);
- steps to reproduce, or a proof of concept;
- whether you have shared it with anyone else.

**Never send a real token, even an expired one.** If a report needs one, describe it instead (for example "a token with only `projects:read`").

We aim to acknowledge reports within three working days and to keep you informed until the problem is fixed. We are glad to credit reporters who want to be credited.

## Scope

In scope:

- this server's code: its transports, authentication handling, Host and Origin checks, logging, untrusted-content marking and error handling;
- the way it handles tokens (for example a token appearing in logs, errors, or a request to the wrong host).

Out of scope here, but welcome at the same address:

- the buildIt.Social apps and the agent API itself.

Not vulnerabilities on their own:

- a model following instructions planted in buildIt.Social content. The `<untrusted_content>` marking is a best-effort signal, not a boundary (see [docs/design.md](docs/design.md#untrusted-content)); a way to break out of the marking itself is in scope;
- issues that need a token the attacker already controls to act only within that token's own permissions.

## Supported versions

Until the first public release, only the latest commit on `main` is supported.

## If a token leaks

Revoke it in buildIt.Social at once (the token's owner or an org admin can), then create a new one. Tokens start with `buildit_pat_`, so secret scanners can find them; this repository's gitleaks configuration includes a rule for them.
