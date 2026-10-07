# Atlantis + tfplanview: GitHub demo

A recorded demo on one public repo. Atlantis runs locally, plans the PR and comments the visual plan (with a
screenshot). GitHub reaches it through a smee.io relay channel, so nothing connects in to your machine. The reports go to the repo's `gh-pages` branch, so the PR keeps
working after Atlantis is switched off.

One-time setup: create a public repo, a fine-grained token limited to it, and `.env` (see `.env.example`).

```sh
just seed          # base stack to main, gh-pages branch, GitHub Pages
just up            # webhook -> relay channel, Atlantis; prints READY
just mr-create     # open the PR
just drift         # (optional) hand-edit a subnet tag outside Terraform
just mr-change-1   # review changes, one commit each
just mr-change-2
just mr-change-3
just mr-change-4
just down          # remove the webhook and stop everything
```
Atlantis accepts events only for the repo in `.env`, checks the webhook secret, and ignores fork PRs. The relay channel
(`SMEE_URL` in `.env`) is readable by anyone who knows its address. Revoke the token when you are done.
