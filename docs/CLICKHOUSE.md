# ClickHouse Cloud provider

Working notes for the ClickHouse Terraform provider
(`registry.terraform.io/ClickHouse/clickhouse`, v3.39.0 at the time of
writing). Status: steps 1 to 6 and 8 to 12 done, step 7 open.

## Goal

Draw ClickHouse Cloud resources in their own cloud box, next to the AWS box,
and show the PrivateLink connection between an `aws_vpc_endpoint` and a
`clickhouse_service`.

## Terms

- Service: compute. Replicas of one size, an endpoint, an IP access list,
  private endpoints, idle scaling. The API and Terraform manage services.
- Warehouse: a set of services that share data. The first service is the
  primary; the others set `warehouse_id` to the primary's and can be
  read-only. Terraform has no warehouse resource, only the `warehouse_id`
  attribute. The console gives a warehouse a name; the plan does not contain
  it.

## AWS integration

ClickHouse runs a VPC endpoint service per region in its own AWS account. The
customer creates an interface endpoint to it and registers the endpoint ID on
the ClickHouse service. ClickHouse does not approve the endpoint. The service
accepts traffic only from endpoint IDs on its allow-list, which the
attachment resource sets.

```hcl
resource "clickhouse_service" "svc" {
  cloud_provider = "aws"
  region         = "us-east-2"
  ip_access      = []   # empty list blocks public access
}

resource "aws_vpc_endpoint" "ch" {
  vpc_id              = aws_vpc.vpc.id
  service_name        = clickhouse_service.svc.private_endpoint_config.endpoint_service_id
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.a.id, aws_subnet.b.id]
  security_group_ids  = [aws_security_group.ch.id]   # tcp 8443 (https), 9440 (native)
  private_dns_enabled = false
}

resource "clickhouse_service_private_endpoints_attachment" "a" {
  service_id           = clickhouse_service.svc.id
  private_endpoint_ids = [aws_vpc_endpoint.ch.id]
}
```

Source: [examples/full/private_endpoint/aws](https://github.com/ClickHouse/terraform-provider-clickhouse/tree/main/examples/full/private_endpoint/aws).

## Constraints

- PrivateLink requires the Scale or Enterprise plan, per the ClickHouse docs.
  A new trial organization accepted it in 2026-10.
- Cross-region PrivateLink is supported, except in `ap-east-2` and
  `mx-central-1`. If the service name fails verification, ClickHouse support
  must add the region.
- The customer configures DNS. `private_endpoint_config.private_dns_hostname`
  must resolve to the endpoint ENIs, usually through a Route 53 private hosted
  zone. Each service has its own hostname, so a second service on the same
  endpoint needs its own record.
- Private access is per service. One `clickhouse_service_private_endpoints_attachment`
  per service lists all its endpoint IDs; several attachments for one service
  give unpredictable results.
- Since 3.2.0, `clickhouse_private_endpoint_registration` and the
  `clickhouse_private_endpoint_config` data source are deprecated. Older code
  still uses them.
- Issue [#719](https://github.com/ClickHouse/terraform-provider-clickhouse/issues/719)
  (open): the attachment also registers the endpoint in the organization's
  private endpoint list, and destroying it leaves that entry. A later apply
  with a new endpoint can fail with HTTP 500 on the attachment. Remove the
  entry (console, or `PATCH /v1/organizations/{id}` with
  `privateEndpoints.remove`) while the organization still has a service: the
  API refuses the change when it has none.
- `clickhouse_clickpipes_reverse_private_endpoint` covers the other direction:
  ClickPipes connects to an endpoint service, MSK cluster or VPC Lattice
  resource in the customer account.
- ClickPipes run on ClickPipes compute, not on the service's replicas. Each
  pipe writes to one service (`service_id`).

In a plan that creates the service, `service_name` and `private_endpoint_ids`
are unknown until apply. The reference is still present in
`configuration...expressions.references`.

## Steps

- [x] **1. Samples.**
  - `samples/aws-clickhouse-plan-only/`: 44 resources (28 AWS, 16
    ClickHouse), generated offline with fake credentials. Included in
    `tools/check-layout.js` and `tools/check-parse.js`.
  - `samples/aws-clickhouse-connectivity/`: applied. EC2 to the service
    through an IP access list or PrivateLink, the service to S3 through an IAM
    role.
  - `samples/aws-clickhouse-s3-clickpipe/`: applied. S3, SQS notifications
    and an S3 ClickPipe; queries over PrivateLink.
  - `demo/atlantis/github-clickhouse/`: an Atlantis PR that adds a read-only
    service to the warehouse, then resizes the writer.
- [x] **2. Provider plugin.** `src/ts/providers/clickhouse/index.ts`.
  - `id: "clickhouse"`, `typePrefix: "clickhouse_"`, `localNames: ["clickhouse"]`,
    `cloudLabel: "ClickHouse Cloud"`.
  - `sourceAddresses`: `registry.terraform.io/clickhouse/clickhouse` and the
    `registry.opentofu.org` equivalent. The plan JSON writes the address in
    lower case.
  - `settingKeys: ["organization_id"]`.
  - Icons: `database` (services), `pipe`, `clock`, `query`.
- [x] **3. Catalog.**

  | Type | Kind | Preview |
  |---|---|---|
  | `clickhouse_service` | group (box), `db` | `cloud_provider`, `region`, `idle_scaling`, `idle_timeout_minutes`; compute from `summary` (step 10) |
  | `clickhouse_service_private_endpoints_attachment` | node | `private_endpoint_ids` |
  | `clickhouse_private_endpoint_registration` | node | `private_endpoint_id`, `cloud_provider`, `region` |
  | `clickhouse_clickpipe` | node, subtitle `source` | `name`, `stopped` |
  | `clickhouse_clickpipes_reverse_private_endpoint` | node, subtitle `type` | `type`, endpoint service name, MSK or VPC Lattice ID |
  | `clickhouse_api_key`, `clickhouse_role`, `clickhouse_organization_settings` | node, global scope | |
  | `clickhouse_role_assignment`, `clickhouse_udf_attachment` | assoc | |

- [x] **4. Rules.** Show `ip_access` entries (source, description) through the
  `rules` hook, for services and API keys. The list ends with an implicit
  row that refuses any other source. `0.0.0.0/0` reads "(anywhere)".
- [x] **5. Placement.** One box per `cloud_provider` and `region`, inside the
  core Region box. Services that share data get a warehouse box: one
  service references another through `warehouse_id`, or both have the same
  known `warehouse_id`. A single service gets no warehouse box. Each service
  is a box containing its settings (private endpoint attachment, upgrade
  window, scheduled scaling, queries). ClickPipes, CDC infrastructure and
  reverse private endpoints sit in the location box next to the warehouse,
  with a line to their service. Organization resources go to Global. The
  Region box label uses the optional `regionNote` plugin field ("per
  service").
- [x] **6. Cross-provider edge.** The VPC endpoint gets one line into the
  ClickHouse box, to the endpoint attachment inside the service box.
  `dropCoveredBoxEdges` (`src/ts/core/layout.ts`) drops the endpoint's line to
  the service box itself, because the attachment line covers it. Core lays out
  each cloud from its own resources only, so the attachment stays in the
  ClickHouse box.
- [ ] **7. Console links.** Not implemented. The console URL format for a
  service is not documented. The service ID is known only after apply, so
  links would appear only for updates and deletes.
- [x] **8. AWS catalog gaps.** The plan-only sample uses four AWS types the
  catalog lacked: `aws_kinesis_stream`, `aws_s3_bucket_notification`,
  `aws_vpc_endpoint_service` and `aws_vpc_endpoint_service_allowed_principal`.
- [x] **9. Tests and docs.** `just test`, baselines, the README provider list,
  a README in each sample folder.
- [x] **10. Compute.** `src/ts/providers/clickhouse/compute.ts`.
  - The service box header shows replicas, memory and vCPU per replica:
    `3 × 8 GiB · 2 vCPU each · idles`. Horizontal autoscaling shows the
    replica band (`2–4 × 16 GiB`).
  - vCPU comes from memory: 4 GiB per vCPU in the default profile, 8 in the
    high-memory profile, none for any other profile.
  - The hover card shows `replicas`, `per replica` and `total` rows through the
    `summary` provider hook.
- [x] **11. Lines to boxes.** Core draws no lines to boxes; it highlights them.
  A provider sets `edges: true` on a container to receive lines. Service boxes
  set it, so a ClickPipe outside the service has a line to it.
- [x] **12. Terraform utility resources.** `time_sleep` (used in the S3
  ClickPipe sample for IAM propagation), `random_*`, `null_resource` and
  `terraform_data` are hidden by default and drawn in a Terraform box when
  shown (`src/ts/core/utility.ts`).

## Open questions

- ClickHouse Cloud offers an HTTP API and no read-only CLI. `cli` returns no
  commands. A `curl` GET to `api.clickhouse.cloud` would need credentials.
- A plan that references an existing service by ID has a literal
  `service_name` on the VPC endpoint and no reference to the service, so the
  endpoint is not linked to the service. Services with the same literal
  `warehouse_id` are already grouped (step 5).
- BYOC (`clickhouse_byoc_infrastructure`) runs ClickHouse in the customer AWS
  account. Out of scope unless needed.
