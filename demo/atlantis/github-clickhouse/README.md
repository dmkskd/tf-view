# Atlantis + tfplanview: ClickHouse demo

A PR on real AWS + ClickHouse Cloud, planned by a local Atlantis that comments the visual plan. Reuses the
GitHub demo's Atlantis image, workflow, report script and PR scripts (`../github`). Stack: `../shared-clickhouse`.

## Stack

- base (`just base confirm`): VPC, EC2 client, S3 + SQS, S3 ClickPipe, one ClickHouse service `tfpv-demo` (3 x 8 GiB) over PrivateLink
- state: `backend "local"` at `/state/terraform.tfstate`, a Docker volume shared by the `base` and `atlantis` containers
- PR, one tfvars key per commit (`shared-clickhouse/revisions.sh`); apart from the read-only service, each step changes a base resource:
  - `mr-create`: `writer_idle_minutes = 15`: writer auto-idle 5 -> 15 min (update)
  - `mr-change-1`: `reporting = true`: read-only service `tfpv-demo-reporting` on the writer's warehouse (2 x 8 GiB), endpoint attachment for the existing VPC endpoint, Route 53 record for its private hostname (3 creates; the warehouse box appears)
  - `mr-change-2`: `writer_replicas = 2`: writer 3 -> 2 replicas (update)
  - `mr-change-3`: `client_instance_type = "t4g.small"`: EC2 client t4g.micro -> t4g.small (update)
  - `mr-change-4`: `events_sort_by_type = false`: events ClickPipe table sorted by `ts` only (replace)
  - `mr-change-5`: `seed = false`: remove the seed file (delete)

## Setup

- `.env` from `.env.example`: a separate repo, token and relay channel from `../github`
- `~/.aws` (default profile) and `~/.clickhouse.env`, mounted read-only into `base` and `atlantis`

## Commands

- `just seed`: stack to the repo's `main`, `gh-pages`, GitHub Pages
- `just base confirm`: apply the base stack (billable)
- `just base-plan`: plan against the state volume
- `just up`: webhook -> relay, start Atlantis on 127.0.0.1:4143
- `just mr-create`, `just mr-change-1` … `just mr-change-5`, or `just demo` (each push waits for the plan of the previous one)
- `just showcase [pr]`: a new demo PR (or the open one) with all five changes, then the plan once per image setting (PNG, SVG tour, tuned tour, sections, replay, still, no HTML), as in `../github`
- `just status`, `just logs`
- `just down`: stop Atlantis, keep the stack
- `just destroy confirm`: destroy the stack, including anything a PR applied

## Notes

- plans are free; `atlantis apply` on the PR creates the reporting service (billable)
- Atlantis runs with your AWS and ClickHouse credentials and plans every push to the repo: use a scoped IAM user rather than root credentials, and keep push access to the repo to yourself
- reports on `gh-pages` contain account IDs, ARNs and hostnames (sensitive values are removed); a private repo keeps them off the web
- the stack uses different names and a different CIDR (`tfpv-demo`, 10.44.0.0/16) from `samples/aws-clickhouse-*`, so both can exist at once
