# Using tfplanview with Atlantis

> **Proof of concept.** The demos in `demo/atlantis/` run end to end against a local AWS emulator with fake data.
> Do not use them in production.

[Atlantis](https://www.runatlantis.io) runs `terraform plan` for each pull request and posts the output as a PR
comment. The integration adds a custom workflow step that renders the plan as an HTML report, uploads it, and posts a
second PR comment with the report URL.

```yaml
# Atlantis server-side repo config (repos.yaml)
workflows:
  tfplanview:
    plan:
      steps:
        - init
        - plan
        - run: sh /opt/tfplanview/report.sh
```

```sh
# core of report.sh
terraform show -json "$PLANFILE" > plan.json
tfview open plan.json -o report.html --no-open --viewer-only --show-changes --label "PR #$PULL_NUM"
# then upload report.html and post a PR comment with its URL and an optional screenshot
```

- `tfview` writes a single self-contained HTML file and replaces values Terraform marks `sensitive` with
  `(sensitive)`.
- An error in `report.sh` must not fail the plan. The demo script logs the error and exits 0;
  `REPORT_STRICT=true` makes it exit non-zero.
- Optional features: an LLM risk review (`tfview explain`, enabled with `TFVIEW_LLM=true`) and a PNG screenshot
  (requires headless Chromium in the Atlantis image).

## Demos

- [`github/`](../demo/atlantis/github): `report.sh` commits the report to the `gh-pages` branch, served by GitHub
  Pages, and attaches the screenshot with `gh pr comment --attach`. GitHub sends webhooks to a smee.io channel; a
  relay container forwards them to Atlantis.
- [`gitlab/`](../demo/atlantis/gitlab): a local GitLab CE instance. An nginx container serves the reports;
  `report.sh` also uploads them to the GitLab project, which serves uploaded HTML files as downloads.

```sh
just up && just mr-create   # in demo/atlantis/github (fill in .env first) or demo/atlantis/gitlab
```

## Open problems

A production deployment must resolve the following issues.

- **Report hosting.** GitHub and GitLab render Markdown in comments but not attached HTML files, so the report needs
  its own URL. Upload it to a web server you already run, e.g. S3 behind SSO, an internal nginx, or a sidecar in the
  Atlantis pod. The Atlantis web UI serves only locks and job logs, and Atlantis deletes the PR's working directory
  when the PR is closed, so Atlantis cannot host the report.
- **Screenshot hosting.** Upload the PNG as a comment attachment (GitHub: `gh pr comment --attach`, gh 2.99 or newer;
  GitLab: the project uploads API). GitHub fetches comment images through its camo proxy over the public internet,
  so images on internal hosts render as broken.
- **Access control and secrets.** Anyone with the URL can open the report, and `tfview` redacts only values Terraform
  marks `sensitive`. Restrict access to the report URL as you restrict access to the plan output.
- **Retention.** Each plan run writes a new report file, and the demos keep every file. Add a cleanup job, e.g. an S3
  lifecycle rule.
- **Packaging.** The demo compiles `tfview` into the Atlantis image. A production deployment builds and versions it in
  its own image pipeline.
- **Tokens.** `report.sh` needs a token with permission to post PR comments and, for GitHub Pages, to push to
  `gh-pages`.
- **Multiple projects per PR.** Atlantis runs the workflow once per project, so a PR that changes N projects gets N
  reports and N comments.
