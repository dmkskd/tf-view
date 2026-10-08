# Atlantis + tfplanview: GitLab demo

Self-hosted GitLab CE, Atlantis and Floci (local AWS emulator, never real AWS). Atlantis plans the MR
and comments a link to the plan rendered by tfplanview.

```sh
just up            # first boot takes several minutes
just mr-create     # open the MR
just drift         # (optional) hand-edit a subnet tag outside Terraform, so the next plan shows drift
just mr-change-1   # review changes, one commit each; Atlantis re-plans every push
just mr-change-2
just mr-change-3
just mr-change-4
just demo          # or: all of the steps above in one go, 60 s apart (just demo 30 for 30 s)
just status        # the MR and its commits
```
`just up` applies a platform once (network, load balancer, database, a legacy bucket; about 2-3 minutes); the MR adds the app tier, deletes the legacy bucket, changes the health check, then adds storage and messaging.
The plan comment embeds a screenshot (needs Chromium in the Atlantis image, so it is much bigger); set `PLAN_IMAGE` to `off` in `docker-compose.yml` to skip it.
The report is made by the `tfview` binary, built into the Atlantis image (`atlantis/report.sh`; the first build compiles it, a few minutes). It removes sensitive values.
Optional LLM review in the report: set `TFVIEW_LLM=true`, `TFVIEW_MODEL` and `TFVIEW_ENDPOINT` (environment, e.g. `TFVIEW_LLM=true TFVIEW_MODEL=... just up`), e.g. `TFVIEW_MODEL=... just up`), e.g. `ollama::qwen2.5:7b` and `http://host.docker.internal:11434` for Ollama on this machine. If the call fails, the plain report is used.
Optional: `just apply`, `just merge`. Stop: `just down`; wipe: `just reset`.

GitLab http://localhost:8929 (root / demo-password-123), Atlantis :4141, reports :8080.
Reports have secrets removed but still show names and config, with no auth: fake data only.
