use anyhow::{bail, Context, Result};
use clap::{Args, Parser, Subcommand};
use genai::adapter::AdapterKind;
use std::env;
use std::fs;
use std::io::{self, IsTerminal, Read};
use std::path::{Path, PathBuf};
use std::process::Command;
use tempfile::Builder;

mod llm;
mod redact;
use llm::*;

// Embed the single self-contained HTML copied into OUT_DIR by build.rs
const HTML_TEMPLATE: &str = include_str!(concat!(env!("OUT_DIR"), "/index.html"));

#[derive(Parser, Debug)]
#[command(
    name = "tfview",
    version,
    about = "Render a Terraform plan as an AWS architecture diagram",
    arg_required_else_help = true,
    after_help = "EXAMPLES:\n  \
      tfview plan                          # Generate safe ephemeral plan & view in browser\n  \
      tfview plan --offline                # Plan without remote cloud API calls (-refresh=false)\n  \
      tfview plan -- -var-file=prod.tfvars # Pass extra flags to 'terraform plan' after '--'\n  \
      tfview open plan.json                # View an existing JSON plan file\n  \
      terraform show -json | tfview open   # Stream plan JSON from piped stdin\n  \
      terraform show -json | tfview        # Piping directly also works!\n  \
      tfview explain plan.json --model ollama::glm-4.7-flash:latest # Analyze with local Ollama\n  \
      tfview explain --model gpt-4o-mini                            # Ephemeral plan & analyze with OpenAI\n  \
      tfview explain plan.json --model gpt-4o-mini --json           # Output clean enriched JSON to stdout"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Generate a safe ephemeral plan (-lock=false) and view it in your browser
    Plan(PlanArgs),

    /// Open an existing Terraform plan JSON file or piped stdin
    #[command(alias = "show")]
    Open(OpenArgs),

    /// Analyze planned changes and generate architectural annotations with an LLM (via genai)
    Explain(ExplainArgs),
}

/// How the report is written; shared by every command that writes one.
#[derive(Args, Debug, Clone, Default)]
struct ReportArgs {
    /// Keep sensitive values in the report (by default they are replaced with "(sensitive)")
    #[arg(long)]
    no_redact: bool,

    /// Hide the Load and Samples buttons: the report shows only this plan
    #[arg(long)]
    viewer_only: bool,

    /// Open the report with "Show changes" on
    #[arg(long)]
    show_changes: bool,

    /// Title shown in the report (default: the plan file name)
    #[arg(long)]
    label: Option<String>,
}

#[derive(Args, Debug)]
struct PlanArgs {
    #[command(flatten)]
    report: ReportArgs,

    /// Save the self-contained HTML report to a file instead of a temporary browser preview
    #[arg(short, long, value_name = "OUTPUT_HTML")]
    output: Option<PathBuf>,

    /// Run plan in fast offline mode (-refresh=false), skipping remote cloud API calls
    #[arg(long)]
    offline: bool,

    /// Generate a destroy plan preview (-destroy)
    #[arg(long)]
    destroy: bool,

    /// Do not automatically launch the web browser
    #[arg(long)]
    no_open: bool,

    /// Pass extra arguments to 'terraform plan' after '--' (e.g. tfview plan -- -var-file=prod.tfvars)
    #[arg(last = true)]
    terraform_args: Vec<String>,
}

#[derive(Args, Debug)]
struct OpenArgs {
    #[command(flatten)]
    report: ReportArgs,

    /// Path to a Terraform JSON plan file (use '-' for stdin). If omitted with piped input, reads stdin.
    #[arg(value_name = "PLAN_JSON")]
    file: Option<PathBuf>,

    /// Save the self-contained HTML report to a file instead of a temporary browser preview
    #[arg(short, long, value_name = "OUTPUT_HTML")]
    output: Option<PathBuf>,

    /// Do not automatically launch the web browser
    #[arg(long)]
    no_open: bool,
}

#[derive(Args, Debug)]
struct ExplainArgs {
    #[command(flatten)]
    report: ReportArgs,

    /// Path to a Terraform JSON plan file (use '-' for stdin). If omitted, generates an ephemeral plan.
    #[arg(value_name = "PLAN_JSON")]
    file: Option<PathBuf>,

    /// LLM provider (e.g. ollama, openai, anthropic, gemini, groq, deepseek, cohere, xai)
    #[arg(long, env = "TFVIEW_PROVIDER")]
    provider: Option<String>,

    /// LLM model to invoke (e.g. glm-4.7-flash:latest, gpt-4o-mini, ollama::glm-4.7-flash:latest).
    /// Can also be set via the TFVIEW_MODEL environment variable.
    #[arg(short, long, env = "TFVIEW_MODEL")]
    model: Option<String>,

    /// Review scope: 'changes' (only diffed resources) or 'full' (entire architecture)
    #[arg(long, value_enum, default_value = "changes")]
    scope: ReviewScope,

    /// Review depth: 'standard' (operational risk triage) or 'expert' (Well-Architected audit)
    #[arg(long, value_enum, default_value = "standard")]
    depth: ReviewDepth,

    /// Sampling temperature, 0 to 2 (lower is steadier: the same plan gets the same rating more often).
    /// Can also be set via the TFVIEW_TEMPERATURE environment variable. Default: the provider's.
    #[arg(long, env = "TFVIEW_TEMPERATURE", value_parser = parse_temperature)]
    temperature: Option<f64>,

    /// Optional custom LLM endpoint URL (e.g. http://localhost:11434).
    /// Can also be set via TFVIEW_ENDPOINT or OLLAMA_HOST.
    #[arg(long, alias = "url", env = "TFVIEW_ENDPOINT")]
    endpoint: Option<String>,

    /// Optional API key for cloud providers.
    /// Can also be set via the TFVIEW_API_KEY environment variable.
    #[arg(long, env = "TFVIEW_API_KEY")]
    api_key: Option<String>,

    /// Save the enriched Terraform plan JSON (with LLM annotations & metrics) to a file
    #[arg(long = "json-out", value_name = "ENRICHED_PLAN_JSON")]
    json_out: Option<PathBuf>,

    /// Print enriched Terraform plan JSON directly to stdout (suppresses browser launch)
    #[arg(long = "json")]
    json_stdout: bool,

    /// Save the self-contained HTML report with LLM annotations to a file
    #[arg(short, long, value_name = "OUTPUT_HTML")]
    output: Option<PathBuf>,

    /// Do not automatically launch the web browser
    #[arg(long)]
    no_open: bool,

    /// Run plan in fast offline mode (-refresh=false) if generating an ephemeral plan
    #[arg(long)]
    offline: bool,

    /// Generate a destroy plan preview (-destroy) if generating an ephemeral plan
    #[arg(long)]
    destroy: bool,

    /// Pass extra arguments to 'terraform plan' after '--' if generating an ephemeral plan
    #[arg(last = true)]
    terraform_args: Vec<String>,
}

fn parse_temperature(s: &str) -> Result<f64, String> {
    let t: f64 = s.trim().parse().map_err(|_| format!("'{s}' is not a number"))?;
    if (0.0..=2.0).contains(&t) {
        Ok(t)
    } else {
        Err(format!("{t} is outside 0 to 2"))
    }
}

/// Validate that user-supplied extra arguments to 'terraform plan' do not attempt
/// to override tfview's non-locking guarantee or redirect plan output to disk.
pub fn validate_ephemeral_plan_args(extra_args: &[String]) -> Result<()> {
    for arg in extra_args {
        let clean = arg.trim_start_matches('-');
        if clean == "out" || clean.starts_with("out=") || clean == "lock" || clean.starts_with("lock=") {
            bail!(
                "Argument '{}' is not permitted in ephemeral plan mode: tfview enforces safe, non-locking execution without leaving persistent plan files on disk.",
                arg
            );
        }
    }
    Ok(())
}

/// Run 'terraform plan' safely in non-locking mode and convert to JSON in-memory.
/// Captures child stdout so human-readable plan text never leaks to stdout.
fn generate_ephemeral_plan(offline: bool, destroy: bool, extra_args: &[String], temp_dir: &Path) -> Result<String> {
    validate_ephemeral_plan_args(extra_args)?;

    let bin_plan = temp_dir.join("ephemeral.tfplan");
    let bin_plan_str = bin_plan.to_str().context("Invalid temp file path")?;

    let mut plan_cmd = Command::new("terraform");
    plan_cmd.arg("plan");

    if offline {
        plan_cmd.arg("-refresh=false");
    }
    if destroy {
        plan_cmd.arg("-destroy");
    }
    for arg in extra_args {
        plan_cmd.arg(arg);
    }

    // Enforce non-locking mode and ephemeral temp path after user args
    plan_cmd.arg("-lock=false");
    plan_cmd.arg(format!("-out={}", bin_plan_str));

    eprintln!("==> [tfview] Running safe ephemeral plan (-lock=false)...");
    let plan_output = plan_cmd
        .output()
        .context("Failed to run 'terraform plan'. Is terraform installed and in your PATH?")?;

    if !plan_output.status.success() {
        let err = String::from_utf8_lossy(&plan_output.stderr);
        let out = String::from_utf8_lossy(&plan_output.stdout);
        bail!(
            "'terraform plan' failed with status: {}.\nStderr: {}\nStdout: {}",
            plan_output.status,
            err.trim(),
            out.trim()
        );
    }

    eprintln!("==> [tfview] Converting plan to in-memory JSON...");
    let show_output = Command::new("terraform")
        .args(["show", "-json", bin_plan_str])
        .output()
        .context("Failed to run 'terraform show -json'")?;

    // Shred the binary plan immediately to guarantee it can never be applied
    let _ = fs::remove_file(&bin_plan);

    if !show_output.status.success() {
        let err = String::from_utf8_lossy(&show_output.stderr);
        bail!("'terraform show -json' failed: {}", err);
    }

    String::from_utf8(show_output.stdout).context("Plan output is not valid UTF-8")
}

/// Replace the contents of `<script type="application/json" id="{id}">` with `json`.
/// Each `<` is replaced by `\u003c`. In valid JSON, `<` occurs only inside
/// strings, where `\u003c` decodes to the same character; after the
/// replacement the block contains no `<`, so it cannot contain the `</script>`
/// that would end it early.
fn fill_json_block(html: &str, id: &str, json: &str) -> Option<String> {
    let tag = format!("<script type=\"application/json\" id=\"{}\">", id);
    let content_start = html.find(&tag)? + tag.len();
    let end_pos = html[content_start..].find("</script>")? + content_start;
    let safe = json.trim().replace('<', "\\u003c");
    let mut out = String::with_capacity(html.len() + safe.len());
    out.push_str(&html[..content_start]);
    out.push_str(&safe);
    out.push_str(&html[end_pos..]);
    Some(out)
}

/// Inject the JSON plan into the self-contained HTML template.
///
/// Writes only JSON data blocks, not scripts: the page's Content-Security-Policy
/// lists only the hash of the page's own script in script-src, so the browser
/// would block an added inline script. Boot settings go in the `tfview-config`
/// block.
pub fn inject_plan(html_template: &str, plan_json: &str, label: &str) -> Result<String> {
    inject_plan_with(html_template, plan_json, label, false, false)
}

/// `inject_plan` plus the boot settings that hide the Load/Samples buttons and turn "Show changes" on.
pub fn inject_plan_with(
    html_template: &str,
    plan_json: &str,
    label: &str,
    viewer_only: bool,
    show_changes: bool,
) -> Result<String> {
    let _: serde_json::Value = serde_json::from_str(plan_json)
        .context("Input is not valid JSON. Ensure input is generated via 'terraform show -json'.")?;

    let with_plan = fill_json_block(html_template, "injected-plan", plan_json)
        .or_else(|| fill_json_block(html_template, "embedded-plan", plan_json))
        .context("Template does not contain an id=\"injected-plan\" or id=\"embedded-plan\" data block")?;

    let mut config = serde_json::json!({ "autoload": true, "label": label });
    if viewer_only {
        config["viewerOnly"] = true.into();
    }
    if show_changes {
        config["showChanges"] = true.into();
    }
    fill_json_block(&with_plan, "tfview-config", &config.to_string())
        .context("Template does not contain an id=\"tfview-config\" data block; rebuild dist/index.html")
}

/// Redact (unless asked not to) and embed the plan in the viewer.
fn render_report(plan_json: &str, default_label: &str, args: &ReportArgs) -> Result<String> {
    let plan_json = if args.no_redact {
        plan_json.to_string()
    } else {
        let mut plan: serde_json::Value = serde_json::from_str(plan_json)
            .context("Input is not valid JSON. Ensure input is generated via 'terraform show -json'.")?;
        redact::redact_plan(&mut plan);
        plan.to_string()
    };
    let label = args.label.as_deref().unwrap_or(default_label);
    inject_plan_with(HTML_TEMPLATE, &plan_json, label, args.viewer_only, args.show_changes)
}

/// Render and display (or save) the final self-contained HTML report.
/// If stdin was piped, connects to /dev/tty or uses a grace period so the browser can read the file.
fn present_report(html_content: String, output: Option<PathBuf>, no_open: bool) -> Result<()> {
    if let Some(out_path) = output {
        fs::write(&out_path, &html_content)
            .with_context(|| format!("Failed to write HTML report to '{}'", out_path.display()))?;
        eprintln!("==> [tfview] Saved self-contained report to: {}", out_path.display());
        if !no_open {
            let _ = opener::open(&out_path);
        }
        return Ok(());
    }

    let tmp_dir = Builder::new()
        .prefix("tfview-")
        .tempdir()
        .context("Failed to create secure temporary directory")?;

    let report_path = tmp_dir.path().join("index.html");
    fs::write(&report_path, html_content)?;

    if !no_open {
        eprintln!("==> [tfview] Opening architecture diagram in your default browser...");
        opener::open(&report_path)
            .context("Failed to open default web browser. Try using '-o report.html' instead.")?;
    } else {
        eprintln!("==> [tfview] Ephemeral report generated at: {}", report_path.display());
    }

    eprintln!("\n👁️  Plan viewer active. Press [Enter] or Ctrl+C to close and shred all temporary files...");
    let mut exit_buf = String::new();

    if io::stdin().is_terminal() {
        let _ = io::stdin().read_line(&mut exit_buf);
    } else {
        #[cfg(unix)]
        {
            if let Ok(tty) = fs::File::open("/dev/tty") {
                let mut reader = io::BufReader::new(tty);
                let _ = io::BufRead::read_line(&mut reader, &mut exit_buf);
                return Ok(());
            }
        }
        // Fallback for non-interactive pipelines (CI, headless scripts):
        eprintln!("==> [tfview] Non-interactive stdin detected. Keeping ephemeral report active for 15s...");
        std::thread::sleep(std::time::Duration::from_secs(15));
    }

    Ok(())
}

fn handle_open(args: OpenArgs) -> Result<()> {
    let (plan_json, label) = if let Some(path) = &args.file {
        if path == Path::new("-") {
            let mut buf = String::new();
            io::stdin().read_to_string(&mut buf)?;
            (buf, "stdin plan".to_string())
        } else {
            let label = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "terraform plan".to_string());
            let content = fs::read_to_string(path)
                .with_context(|| format!("Failed to read plan JSON from '{}'", path.display()))?;
            (content, label)
        }
    } else if !io::stdin().is_terminal() {
        eprintln!("==> [tfview] Reading plan JSON from standard input...");
        let mut buf = String::new();
        io::stdin().read_to_string(&mut buf)?;
        (buf, "piped plan".to_string())
    } else {
        bail!("No plan JSON file provided. Usage: 'tfview open <PLAN_JSON>' or pipe via 'terraform show -json | tfview'");
    };

    let html = render_report(&plan_json, &label, &args.report)?;
    present_report(html, args.output, args.no_open)
}

fn handle_plan(args: PlanArgs) -> Result<()> {
    let tmp_dir = Builder::new()
        .prefix("tfview-plan-")
        .tempdir()
        .context("Failed to create temporary directory for planning")?;

    let plan_json = generate_ephemeral_plan(args.offline, args.destroy, &args.terraform_args, tmp_dir.path())?;
    let html = render_report(&plan_json, "terraform plan", &args.report)?;
    present_report(html, args.output, args.no_open)
}

async fn handle_explain(args: ExplainArgs) -> Result<()> {
    let (target_adapter, model) = resolve_model(args.provider.as_deref(), args.model.as_deref())?;
    let client = build_genai_client(target_adapter, args.api_key, args.endpoint);
    let resolved_adapter = target_adapter
        .or_else(|| AdapterKind::from_model(&model).ok())
        .unwrap_or(AdapterKind::Ollama);
    let provider_name = resolved_adapter.as_lower_str().to_string();

    let (plan_json, label) = if let Some(path) = &args.file {
        if path == Path::new("-") {
            let mut buf = String::new();
            io::stdin().read_to_string(&mut buf)?;
            (buf, "stdin plan".to_string())
        } else {
            let label = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "terraform plan".to_string());
            let content = fs::read_to_string(path)
                .with_context(|| format!("Failed to read plan JSON from '{}'", path.display()))?;
            (content, label)
        }
    } else {
        // No file provided: generate ephemeral plan safely (even in CI/non-interactive environments)
        let tmp_dir = Builder::new()
            .prefix("tfview-explain-")
            .tempdir()
            .context("Failed to create temporary directory for planning")?;
        let json = generate_ephemeral_plan(args.offline, args.destroy, &args.terraform_args, tmp_dir.path())?;
        (json, "terraform plan".to_string())
    };

    let mut plan_val: serde_json::Value = serde_json::from_str(&plan_json)
        .context("Input is not valid JSON. Ensure input is from 'terraform show -json'.")?;

    let (_total_res, target_resources) = match args.scope {
        ReviewScope::Changes => {
            let (tot, changed) = extract_changed_resources(&plan_val);
            eprintln!("==> [tfview] Found {} changed resources (out of {} total) for changes review.", changed.len(), tot);
            (tot, changed)
        }
        ReviewScope::Full => {
            let (tot, all_res) = extract_full_architecture(&plan_val);
            eprintln!("==> [tfview] Extracted {} total planned resources for full architecture review.", tot);
            (tot, all_res)
        }
    };

    // Explicit user egress notice
    let is_local = resolved_adapter == AdapterKind::Ollama;
    if is_local {
        eprintln!(
            "==> [tfview] Analyzing {} resources with local Ollama model '{}' (scope: {}, depth: {})...",
            target_resources.len(),
            model,
            args.scope,
            args.depth
        );
    } else {
        eprintln!(
            "==> [tfview] Sending {} redacted resources to remote provider '{}' (model: '{}', scope: {}, depth: {})...",
            target_resources.len(),
            provider_name,
            model,
            args.scope,
            args.depth
        );
    }

    let (llm_analysis, metrics) = run_llm_analysis(&client, &model, &target_resources, args.scope, args.depth, args.temperature).await?;

    if !args.json_stdout {
        print_terminal_summary(&llm_analysis, &metrics, &provider_name, &model, args.scope, args.depth);
    }

    enrich_plan_with_llm(&mut plan_val, &llm_analysis, &metrics, &provider_name, &model, args.scope, args.depth);
    let enriched_plan_json = serde_json::to_string_pretty(&plan_val)?;

    if let Some(json_path) = &args.json_out {
        fs::write(json_path, &enriched_plan_json)
            .with_context(|| format!("Failed to write enriched plan JSON to '{}'", json_path.display()))?;
        eprintln!("==> [tfview] Saved enriched plan JSON to: {}", json_path.display());
    }

    if args.json_stdout {
        println!("{}", enriched_plan_json);
        return Ok(());
    }

    let html = render_report(&enriched_plan_json, &label, &args.report)?;
    present_report(html, args.output, args.no_open)
}

#[tokio::main]
async fn main() -> Result<()> {
    if env::args().len() == 1 && !io::stdin().is_terminal() {
        return handle_open(OpenArgs {
            report: ReportArgs::default(),
            file: None,
            output: None,
            no_open: false,
        });
    }

    let cli = Cli::parse();

    match cli.command {
        Some(Commands::Plan(args)) => handle_plan(args),
        Some(Commands::Open(args)) => handle_open(args),
        Some(Commands::Explain(args)) => handle_explain(args).await,
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEMPLATE: &str = r#"<!DOCTYPE html><html><head><script type="application/json" id="tfview-config">{}</script><script type="application/json" id="embedded-plan">{}</script></head><body></body></html>"#;

    #[test]
    fn test_inject_plan_escapes_script_breakout_xss() {
        let template = r#"<!DOCTYPE html><html><head><script type="application/json" id="tfview-config">{}</script><script type="application/json" id="embedded-plan">{}</script></head><body></body></html>"#;
        let malicious_plan = r#"{"user_data": "echo </script><script>alert(1)</script>"}"#;

        let injected = inject_plan(template, malicious_plan, "test-plan").unwrap();

        // Must NOT contain literal </script> inside the embedded-plan content
        let start_pos = injected.find(r#"id="embedded-plan">"#).unwrap();
        let end_pos = injected[start_pos..].find(r#"</script>"#).unwrap() + start_pos;
        let script_content = &injected[start_pos..end_pos];

        assert!(!script_content.contains("</script>"));
        assert!(script_content.contains(r#"\u003c/script>"#));

        // When parsed as JSON, it recovers the original string verbatim
        let parsed = block(&injected, "embedded-plan");
        assert_eq!(parsed["user_data"], "echo </script><script>alert(1)</script>");
    }

    /// The text of the `id` data block, parsed.
    fn block(html: &str, id: &str) -> serde_json::Value {
        let tag = format!("id=\"{}\">", id);
        let start = html.find(&tag).unwrap() + tag.len();
        let end = html[start..].find("</script>").unwrap() + start;
        serde_json::from_str(&html[start..end]).unwrap()
    }

    #[test]
    fn test_inject_plan_writes_boot_config() {
        let template = TEMPLATE;
        let plan = r#"{"format_version": "1.0"}"#;

        let injected = inject_plan(template, plan, "my-production-plan").unwrap();

        let cfg = block(&injected, "tfview-config");
        assert_eq!(cfg["autoload"], true);
        assert_eq!(cfg["label"], "my-production-plan");
    }

    #[test]
    fn test_inject_plan_adds_no_script() {
        // the page's CSP allows only its own script (by hash); an added inline script would be blocked
        let injected = inject_plan(TEMPLATE, r#"{"format_version": "1.0"}"#, "x").unwrap();
        assert_eq!(injected.matches("<script").count(), TEMPLATE.matches("<script").count());
        assert!(!injected.contains("<script>"));
    }

    #[test]
    fn test_inject_plan_escapes_label_breakout_xss() {
        let plan = r#"{"format_version": "1.0"}"#;
        let malicious_label = r#"</script><script>alert('xss')</script>"#;

        let injected = inject_plan(TEMPLATE, plan, malicious_label).unwrap();

        assert!(!injected.contains("</script><script>alert('xss')"));
        assert_eq!(block(&injected, "tfview-config")["label"], malicious_label);
    }

    #[test]
    fn test_inject_plan_requires_config_block() {
        let old = r#"<html><body><script type="application/json" id="embedded-plan">{}</script></body></html>"#;
        assert!(inject_plan(old, "{}", "x").is_err());
    }

    #[test]
    fn test_inject_plan_with_writes_viewer_only_and_show_changes() {
        let on = inject_plan_with(TEMPLATE, "{}", "x", true, true).unwrap();
        let cfg = block(&on, "tfview-config");
        assert_eq!(cfg["viewerOnly"], true);
        assert_eq!(cfg["showChanges"], true);

        // off: the keys are absent, so the viewer keeps its own defaults
        let off = block(&inject_plan_with(TEMPLATE, "{}", "x", false, false).unwrap(), "tfview-config");
        assert!(off.get("viewerOnly").is_none() && off.get("showChanges").is_none());
    }

    const SECRET_PLAN: &str = r#"{"variables":{"pw":{"value":"hunter2-do-not-leak"}},
        "configuration":{"root_module":{"variables":{"pw":{"sensitive":true}}}},
        "resource_changes":[{"address":"aws_db_instance.main","change":{"actions":["create"],"before":null,
        "after":{"password":"hunter2-do-not-leak","name":"main"},"after_sensitive":{"password":true}}}]}"#;

    #[test]
    fn test_render_report_redacts_by_default() {
        let html = render_report(SECRET_PLAN, "x", &ReportArgs::default()).unwrap();
        assert!(!html.contains("hunter2-do-not-leak"));
        let plan = block(&html, "injected-plan");
        assert_eq!(plan["resource_changes"][0]["change"]["after"]["password"], "(sensitive)");
        assert_eq!(plan["resource_changes"][0]["change"]["after"]["name"], "main");
    }

    #[test]
    fn test_render_report_no_redact_keeps_values() {
        let args = ReportArgs { no_redact: true, ..Default::default() };
        assert!(render_report(SECRET_PLAN, "x", &args).unwrap().contains("hunter2-do-not-leak"));
    }

    #[test]
    fn test_render_report_label_flag_overrides_the_default() {
        let args = ReportArgs { label: Some("PR #7".into()), ..Default::default() };
        let html = render_report("{}", "plan.json", &args).unwrap();
        assert_eq!(block(&html, "tfview-config")["label"], "PR #7");
        assert_eq!(block(&render_report("{}", "plan.json", &ReportArgs::default()).unwrap(), "tfview-config")["label"], "plan.json");
    }

    #[test]
    fn test_render_report_rejects_invalid_json() {
        assert!(render_report("not json", "x", &ReportArgs::default()).is_err());
    }

    #[test]
    fn test_parse_temperature() {
        assert_eq!(parse_temperature("0"), Ok(0.0));
        assert_eq!(parse_temperature(" 0.7 "), Ok(0.7));
        assert_eq!(parse_temperature("2"), Ok(2.0));
        assert!(parse_temperature("-0.1").is_err());
        assert!(parse_temperature("2.1").is_err());
        assert!(parse_temperature("hot").is_err());
        assert!(parse_temperature("NaN").is_err());
    }

    #[test]
    fn test_validate_ephemeral_plan_args_rejects_out() {
        assert!(validate_ephemeral_plan_args(&["-out=plan.bin".to_string()]).is_err());
        assert!(validate_ephemeral_plan_args(&["--out=plan.bin".to_string()]).is_err());
        assert!(validate_ephemeral_plan_args(&["-out".to_string(), "plan.bin".to_string()]).is_err());
        assert!(validate_ephemeral_plan_args(&["--out".to_string(), "plan.bin".to_string()]).is_err());
    }

    #[test]
    fn test_validate_ephemeral_plan_args_rejects_lock() {
        assert!(validate_ephemeral_plan_args(&["-lock=true".to_string()]).is_err());
        assert!(validate_ephemeral_plan_args(&["--lock=true".to_string()]).is_err());
        assert!(validate_ephemeral_plan_args(&["-lock=false".to_string()]).is_err());
        assert!(validate_ephemeral_plan_args(&["-lock".to_string()]).is_err());
        assert!(validate_ephemeral_plan_args(&["--lock".to_string()]).is_err());
    }

    #[test]
    fn test_validate_ephemeral_plan_args_accepts_valid() {
        let valid_args = vec![
            "-var=env=prod".to_string(),
            "-target=aws_s3_bucket.main".to_string(),
            "-parallelism=10".to_string(),
            "-lock-timeout=10s".to_string(),
        ];
        assert!(validate_ephemeral_plan_args(&valid_args).is_ok());
    }
}
