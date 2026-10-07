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
just status        # the MR and its commits
```
`just up` applies a base once (network + a legacy bucket); the MR adds an app, deletes the legacy bucket, updates the VPC tag, then adds a bucket and messaging.
The plan comment embeds a screenshot (needs Chromium in the Atlantis image, so it is much bigger); set `PLAN_IMAGE` to `off` in `docker-compose.yml` to skip it.
Optional: `just apply`, `just merge`. Stop: `just down`; wipe: `just reset`.

GitLab http://localhost:8929 (root / demo-password-123), Atlantis :4141, reports :8080.
Reports have secrets removed but still show names and config, with no auth: fake data only.
