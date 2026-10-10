# `tfview` CLI

`tfview` is a single Rust binary with the viewer embedded. It renders a Terraform plan as one self-contained HTML
file, and can run `terraform plan` itself or add an LLM review.

## Build

Building requires Node.js, npm, Rust, Cargo and `just`. Running the binary requires only Terraform on `PATH`, and
only for `tfview plan` and for `tfview explain` without a plan file.

```sh
npm ci
just cli-build      # builds dist/index.html and embeds it in cli/target/release/tfview
just cli-install    # optional: installs into ~/.cargo/bin
```

Rebuild the CLI after a frontend change.

## Commands

```sh
tfview plan                                          # runs terraform plan in the current directory and opens the HTML report in the browser
tfview plan -o report.html -- -var-file=prod.tfvars  # runs terraform plan with prod.tfvars and saves the HTML report to report.html
tfview open plan.json                                # opens the HTML report for plan.json, an existing `terraform show -json` output
terraform show -json plan.out | tfview open -        # opens the HTML report for a JSON plan read from standard input
```

- **`plan`** produces the HTML report for the Terraform configuration in the current working directory, which must
  be initialised with `terraform init`. It runs `terraform plan -lock=false` into a temporary binary plan, converts
  it with `terraform show -json`, and deletes the binary plan. Arguments after `--` go to `terraform plan` (except
  `-out` and `-lock`). `--offline` adds `-refresh=false`; data sources and providers can still make network calls.
- **`open`** produces the HTML report from a JSON plan in a file or on standard input. It calls neither Terraform nor
  a model.
- **`explain`** adds an LLM review, see below.

## Output

- Without `-o`, the report is written to a temporary directory and opened in the browser. `tfview` deletes it when
  you press Enter or Ctrl+C (or after 15 seconds when no terminal is attached).
- `-o report.html` saves the report and exits.
- The report replaces values Terraform marks `sensitive` with `(sensitive)`. Other secrets, such as a password in a
  plain string, stay in the report.

## LLM review (`explain`)

```sh
tfview explain plan.json --model ollama::my-model
tfview explain plan.json --model my-model --provider openai --api-key "$KEY"
tfview explain --model ollama::my-model --offline     # runs terraform plan in the current directory first
tfview explain plan.json --model ollama::my-model --json > reviewed.json
```

The review adds a summary, risk level, blast radius, warnings and per-resource notes to the report. `explain` calls
the model through the Rust crate [`genai`](https://github.com/jeremychone/rust-genai) (0.2); its README lists the
supported providers and models. `tfview` enables OpenAI, Anthropic, Gemini, Ollama, Groq, DeepSeek, Cohere and xAI.

| | |
| --- | --- |
| Model | `--model` is required. The provider comes from a prefix (`ollama::`, `anthropic/`), from `--provider`, or else from `genai`'s mapping of model names (e.g. `gpt-*` to OpenAI, `claude-*` to Anthropic, any unrecognised name to Ollama). |
| API key | `--api-key` or `TFVIEW_API_KEY`; otherwise `genai` reads the provider's standard variable, e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`. Ollama needs no key. |
| Resources | `--scope changes` (default): created, updated, replaced and deleted. `--scope full`: everything in `planned_values`. At most 150 resources and about 250 KB, replacements and deletions first. |
| Sent to the model | Address, type, action and before/after values of each resource. `sensitive` values and credential-like attributes are masked. Use Ollama to keep the plan on your machine. |
| Output | The HTML report. `--json-out PATH` writes the plan JSON with the review under `annotations.llm_review` to PATH; `--json` writes that JSON to standard output. The JSON output is not redacted. |

The risk rating can differ between two runs on the same plan; `--temperature 0` makes it more consistent.

| Option | Effect |
| --- | --- |
| `-m`, `--model NAME` | Model, e.g. `ollama::gpt-oss:20b`. |
| `--provider NAME` | `openai`, `anthropic`, `gemini`, `ollama`, `groq`, `deepseek`, `cohere` or `xai`. |
| `--scope changes\|full` | Resources to review. |
| `--depth standard\|expert` | Review prompt. |
| `--temperature 0-2` | Sampling temperature (default: the provider's). |
| `--endpoint URL` | Model API URL (alias `--url`). |
| `--api-key KEY` | Provider API key. |
| `--json-out PATH` | Save the plan JSON with the review. |
| `--json` | Print the plan JSON with the review instead of writing HTML. |

Environment variables: `TFVIEW_PROVIDER`, `TFVIEW_MODEL`, `TFVIEW_TEMPERATURE`, `TFVIEW_ENDPOINT`, `TFVIEW_API_KEY`;
`OLLAMA_HOST` for Ollama.

## Common options

| Option | Commands | Effect |
| --- | --- | --- |
| `-o`, `--output PATH` | all | Save the HTML report. |
| `--no-open` | all | Do not open the browser. |
| `--label TEXT` | all | Report title (default: the plan file name). |
| `--viewer-only` | all | Hide the Load and Samples buttons. |
| `--show-changes` | all | Open with "Show changes" on. |
| `--no-redact` | all | Keep `sensitive` values in the report. |
| `--offline` | `plan`, `explain` | Add `-refresh=false`. |
| `--destroy` | `plan`, `explain` | Generate a destroy plan. |
| `-- ARGS` | `plan`, `explain` | Pass arguments to `terraform plan`. |

`tfview <command> --help` lists the current syntax.
