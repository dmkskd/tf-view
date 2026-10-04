# Atlantis + tfplanview demo (fully local)

GitLab CE, Atlantis and Floci (local AWS emulator) from one `docker compose`. Atlantis plans an MR,
then a custom workflow step renders the plan with tfplanview and comments a link to the HTML.

```sh
cd demo/atlantis
just up      # builds dist/index.html if missing, starts everything, follows the one-time setup
just demo    # MR 1: adds a queue. Atlantis autoplans and comments with the visual-plan link
```
To see a **diff**: comment `atlantis apply` on MR 1 (applies to Floci, state lives in Floci's S3), merge it, then
```sh
just demo change   # MR 2: an in-place update, a replacement and a destroy against the applied state
```
GitLab's first boot takes several minutes. Without `just`: `just build` at the repo root, then
`docker compose up -d --build`, then `docker compose run --rm --build demo`.

Comment `atlantis apply` on the MR to apply against Floci (never real AWS).

- GitLab: http://localhost:8929 (root / demo-password-123). Atlantis: http://localhost:4141. Reports: http://localhost:8080 (`./reports`).
- `setup` is a one-shot container (`setup/setup.sh`): token, project `root/demo-infra`, webhook, initial commit. Safe to re-run.
- Reset: `just reset`.
