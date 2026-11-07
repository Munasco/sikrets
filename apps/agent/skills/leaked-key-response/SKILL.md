---
name: Leaked-key response
description: Walk through responding to a leaked credential end to end, from identifying it and rotating it to checking for use, finding every copy and preventing a repeat. Use when a key was pushed, posted, logged or flagged by a leak notice.
---
# Leaked-key response

A leaked key is compromised from the moment it was exposed. Deleting it from the code doesn't help: it stays in git history, forks, caches, CI logs and package tarballs. Rotation is the fix; everything else limits the damage.

## Steps, in order

1. **Identify it.** Run `scan_text` on what the user pasted, or `scan_github_repo` on the repo. If they only have a leak notice with SHA-256 hashes, use `check_leak_hashes`. Name the key by type and redacted form (prefix…last4); never repeat it.
2. **Ask three things if they haven't said:** where it was exposed (public repo, private repo, logs, chat, a screenshot), since when, and what it can do (read-only, live payments, admin).
3. **Rotate now.** `how_to_rotate <service>` for the steps.
   - Public exposure: revoke first, then issue the new key. A few minutes of downtime beats an attacker's head start.
   - Private exposure with production depending on it: issue the new key, deploy it, then revoke the old one the same day.
4. **Check for use.** Point them at the provider's audit or usage logs for the exposure window: unknown IPs, new resources, charges, data exports, new keys or users created with the leaked one.
5. **Find every copy.** The same key in other repos and forks, CI/CD secrets and logs, `.env` files on servers, Docker image layers, published package tarballs, and shared docs. Each copy of the old key is harmless once it's revoked; each copy of the new key must not exist.
6. **Clean history (optional).** `git filter-repo --replace-text` or BFG, then a coordinated force-push. Say plainly that this reduces exposure but doesn't undo it: GitHub keeps cached views and pull-request refs until support purges them.
7. **Store the new key properly.** `sikrets add <service>` (prompts for the key, hidden) or `sikrets proxy add <service>`; if it was already in Sikrets, `sikrets rotate` replaces it in place. Agents and scripts get it through `sikrets session run <service> --for 1h -- <command>`, never as a raw env var or flag.
8. **Prevent a repeat.** Turn on GitHub push protection and add a pre-commit secret scan (`gitleaks protect --staged`).

## Answer shape

Start with what to do in the next five minutes (step 3), then the rest as a short checklist. End with a two-line incident note the user can paste: what leaked, when, where, when it was rotated, whether any use was found.
