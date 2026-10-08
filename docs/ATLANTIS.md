# Using tfplanview with Atlantis

> **Proof of concept.** The demos in `demo/atlantis/` show that it works end to end against a local AWS emulator
> and fake data. They are not a production setup: read [the problems](#problems-to-solve-before-real-use) first.

[Atlantis](https://www.runatlantis.io) runs `terraform plan` for each pull request and comments the text plan. The
integration adds one step to that workflow: turn the plan into a tfplanview report, put the report somewhere a
reviewer can open it, and link it in a second comment.

## General

```yaml
# repos.yaml (server side)
workflows:
  tfplanview:
    plan:
      steps:
        - init
        - plan
        - run: sh /opt/tfplanview/report.sh      # the new step
```

The step, in short:

```sh
terraform show -json "$PLANFILE" > plan.json
tfview open plan.json -o report.html --no-open --viewer-only --show-changes --label "PR #$PULL_NUM"
# publish report.html somewhere; post a comment with the link (and a screenshot, if wanted)
```

- **The `tfview` binary** (`cli/`) embeds the viewer in one self-contained HTML file. It replaces values Terraform marks
  sensitive with `(sensitive)` (use `--no-redact` to keep them). `--viewer-only` hides the Load and Samples buttons;
  `--show-changes` opens with changes marked. The demo builds it into the Atlantis image from this repository.
- **The step must not fail the plan.** The demo's `report.sh` logs a failure and exits 0 (`REPORT_STRICT=true` changes
  that), and every network call has a time limit.
- **Optional LLM review.** `tfview explain` adds a risk summary to the report and the comment (`TFVIEW_LLM=true`,
  `TFVIEW_MODEL`, `TFVIEW_ENDPOINT`, `TFVIEW_TEMPERATURE`). The demo uses Ollama on the same machine. The wording and
  sometimes the rating vary between runs; treat it as a reading aid, not a gate.
- **Optional screenshot.** Headless Chromium in the image renders the report to a PNG for the comment. It makes
  the image much bigger and cuts off long plans at 1400x900.

## GitHub

`demo/atlantis/github/` - one public repo, Atlantis on your machine, nothing connects in.

- **Webhook:** GitHub cannot reach a laptop, so a [smee.io](https://smee.io) channel relays events; a container
  connects out to it. Real setups expose Atlantis normally.
- **Hosting:** the report is committed to the `gh-pages` branch and served by GitHub Pages. The link keeps working
  after Atlantis is switched off.
- **Comment:** `gh pr comment --attach` uploads the screenshot (GitHub has no REST API for comment images; this needs
  gh 2.99 or newer). The image is then wrapped in a link to the report.
- **Token:** a fine-grained token limited to the repo (contents, pull requests, issues, commit statuses).

```sh
just up && just demo      # in demo/atlantis/github, after filling in .env
```

## GitLab

`demo/atlantis/gitlab/` - a local GitLab CE with Atlantis beside it.

- **Webhook:** set up automatically; GitLab and Atlantis share a network, so no relay.
- **Hosting:** GitLab stores uploaded HTML but only offers it as a download, never renders it. The demo also serves
  the reports from a small nginx container (`http://127.0.0.1:8080`) and links that.
- **Comment:** the screenshot is uploaded to the project and shown inline.

```sh
just up && just demo      # in demo/atlantis/gitlab
```

## Problems to solve before real use

1. **Where to host the HTML.** Neither GitHub nor GitLab renders an HTML attachment, so the report needs a web
   address. GitHub Pages sites are public (access-controlled Pages needs Enterprise Cloud); GitLab Pages is a pipeline job. Realistic
   options: an object store or internal web server behind your SSO, or the CI artifact store. The demo's choices
   (a public `gh-pages` branch, an unauthenticated nginx) are for fake data only.
2. **Who can open the link.** A report URL has no access control of its own. Anyone with the link sees the plan.
3. **Secrets.** Only values Terraform marks `sensitive` are redacted. A secret in a plain string, `user_data` or a tag
   stays visible. Reports also show resource names, config, account IDs and ARNs. Treat a report like the plan
   output itself. Published files persist after the PR closes (in `gh-pages` history, even if deleted later).
4. **Retention.** Each plan writes a new report file. Nothing cleans them up.
5. **The binary in the Atlantis image.** There is no published release; the demo compiles `cli/` in a Docker build
   stage (a few minutes) and embeds `dist/index.html`. You would build and version it in your own image pipeline.
6. **Credentials for the comment.** The step needs a token that can comment (and, for GitHub Pages, write to the
   repo). Atlantis's own token may not be enough or may be more than you want to give a script.
7. **Atlantis folds step output** into its collapsed plan comment, so the link and screenshot go in a second comment,
   one per plan.
8. **Screenshots are fragile.** They depend on Chromium in the image, a fixed window size and, on GitHub, an
   upload route that is not a documented API.
9. **LLM review sends data out.** The model gets the (redacted) changed resources. A local model keeps them on your
   machine; a hosted one does not. Output is not deterministic and the demo's prompts are tuned to one plan.
10. **Reachability.** The demos avoid exposing Atlantis (a relay on GitHub, a shared network on GitLab). Production
    needs a normal, secured webhook endpoint.
11. **Several projects per PR.** The demo has one project. Each project would produce its own report and comment.
