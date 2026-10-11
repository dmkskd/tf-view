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
- Optional features: an LLM risk review (`tfview explain`, enabled with `TFVIEW_LLM=true`) and an image of the
  diagram in the comment (requires headless Chromium in the Atlantis image). All settings are listed in
  `demo/atlantis/shared/lib.sh`.

## Comment image

`PLAN_IMAGE=svg` replaces the PNG screenshot with an SVG of the diagram. The SVG follows the reader's light or dark
theme and animates the changes. GitHub and GitLab show it as an image, so CSS animation runs and hover does not.
The report page draws the SVG. `report.sh` turns each setting into a URL parameter of the report (the "Page
option" column), loads `report.html?export=svg&...` in headless Chromium with `--dump-dom`, and saves the SVG source
that the page prints in place of the diagram.

| Setting | Page option | Values (default first) | Effect |
|---|---|---|---|
| `REPORT_HTML` | | `on`, `off` | `off`: no HTML report is published or kept; the comment contains only the image and sections |
| `PLAN_IMAGE` | `export=svg` | `on`, `svg`, `off` | `on`: PNG screenshot. `svg`: SVG, with the PNG as fallback |
| `PLAN_IMAGE_DETAILS` | `details` | `0` to `20` | a collapsible section per change: image crop, Terraform's reason, attribute diff |
| `PLAN_IMAGE_STYLE` | `style` | `tour`, `replay` | `tour` zooms to each change in turn; `replay` applies the changes one by one |
| `PLAN_IMAGE_ANIMATION` | `animate=0` | `on`, `off` | `off`: a still image; changes keep an outline |
| `PLAN_IMAGE_TOUR` | `tour=0` | `on`, `off` | `off`: no tour or replay; changes pulse |
| `PLAN_IMAGE_TOUR_STOPS` | `tourstops` | `8`, `0` to `20` | changes the tour visits, most destructive first; a final card counts the rest |
| `PLAN_IMAGE_TOUR_DELAY` | `tourdelay` | `0` to `60` | seconds on the whole diagram before the first tour or replay |

- Sections and crops show the attribute values from the plan, with values Terraform marks `sensitive` redacted.
- Viewers with reduced motion enabled see a still image.
- With `REPORT_HTML=off` on GitHub, the images are comment attachments. If GitHub refuses SVG attachments, `report.sh`
  posts still PNGs instead.
- `just svg-preview plan.json` opens a report with `export=svg&preview=1`. The page shows the image and sections as a
  comment shows them, with controls for each setting.

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
  when the PR is closed, so Atlantis cannot host the report. `REPORT_HTML=off` posts the image and sections only,
  without a report to host.
- **Screenshot hosting.** Upload the PNG as a comment attachment (GitHub: `gh pr comment --attach`, gh 2.99 or newer;
  GitLab: the project uploads API). GitHub fetches comment images through its camo proxy over the public internet,
  so images on internal hosts render as broken. The same applies to the SVG and its crops.
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
