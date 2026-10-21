# tf plan view

Renders a `Terraform` plan as an `AWS` architecture diagram. 

![image](docs/images/3d-screenshot.png)

The web page uses a Terraform plan JSON file as input and does not make any AWS API calls.

Designed as a single html page - available at [https://dmkskd.github.io/tf-view/](https://dmkskd.github.io/tf-view/)

*tf plan* Pull Request example integrated in Atlantis: [tf-view-demo](https://github.com/dmkskd/tf-view-demo/pull/30)

## How to use

1. Generate the `terraform` json plan

```
cd <terraform-dir>
terraform plan -out=plan.out
terraform show -json plan.out > plan.json
```

2. Open the project's index.html ([available as github page](https://dmkskd.github.io/tf-plan-view/))
```sh
just open              # empty page
just open plan.json    # page with plan.json loaded
```

3. Load the generated `plan.json` with the **Load plan json** button or by dropping it on the
page, unless `just open` loaded it.

Plan files selected or dropped onto the page remain local and are not uploaded to a server.
**Sample plan** loads
plans embedded in `index.html`.

## Command line

`tfview` is a standalone binary that produces a self-contained HTML report from a Terraform plan. It can generate a plan from the current directory or use an existing plan JSON file:

```sh
tfview plan
tfview open plan.json
```

The optional `explain` command adds model-generated review annotations. See the [CLI guide](docs/CLI.md) for building the binary from source, command options, output handling, and data sent to a model.

## Atlantis

`tfview` can be integrated with [Atlantis](https://www.runatlantis.io/). See [Atlantis integration](docs/ATLANTIS.md) for setup and known limitations. Examples: [PR #13](https://github.com/dmkskd/tf-view-demo/pull/13), [PR #9](https://github.com/dmkskd/tf-view-demo/pull/9).

## Things to know

- Reads `terraform show -json` plan output. Containment is inferred from `configuration.root_module.resources[].expressions[*].references`.
- AWS, ClickHouse Cloud, and a starter Google Cloud provider (networks, subnetworks, instances, buckets). Resources of other providers are reported, not drawn. See [Development](docs/DEVELOPMENT.md#providers) to add one.
- Unrecognised resource types are drawn as dashed amber tiles and reported.
- Unrecognised and unplaced resources are listed under Validation.

See [Development](docs/DEVELOPMENT.md) to modify or verify the app.

## License

[Apache License 2.0](LICENSE). The bundled fonts are under the SIL Open Font License 1.1 (see [src/fonts](src/fonts/README.md)).
