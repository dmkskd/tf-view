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
just demo          # or all of the steps above in one go, 60 s apart (just demo 30 for 30 s)
just down          # remove the webhook and stop everything
```
The report is made by the `tfview` binary, built into the Atlantis image (`atlantis/report.sh`; the first build compiles it, a few minutes). It removes sensitive values.
Optional LLM review in the report: set `TFVIEW_LLM=true`, `TFVIEW_MODEL` and `TFVIEW_ENDPOINT` in `.env`, e.g. `ollama::qwen2.5:7b` and `http://host.docker.internal:11434` for Ollama on this machine. If the call fails, the plain report is used.
Atlantis accepts events only for the repo in `.env`, checks the webhook secret, and ignores fork PRs. The relay channel
(`SMEE_URL` in `.env`) is readable by anyone who knows its address. Revoke the token when you are done.
