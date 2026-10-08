use anyhow::{bail, Context, Result};
use genai::adapter::AdapterKind;
use genai::chat::{ChatMessage, ChatOptions, ChatRequest, ChatResponseFormat};
use genai::resolver::{AuthData, Endpoint};
use genai::{Client, ModelIden, ServiceTarget};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;

#[derive(clap::ValueEnum, Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewScope {
    /// Review only the resources changing in this plan (default)
    Changes,
    /// Holistic review of the entire planned architecture
    Full,
}

impl std::fmt::Display for ReviewScope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReviewScope::Changes => write!(f, "changes"),
            ReviewScope::Full => write!(f, "full"),
        }
    }
}

#[derive(clap::ValueEnum, Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewDepth {
    /// Focus on operational risk, downtime, and blast radius (default)
    Standard,
    /// Deep audit against AWS Well-Architected Framework & Terraform best practices
    Expert,
}

impl std::fmt::Display for ReviewDepth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReviewDepth::Standard => write!(f, "standard"),
            ReviewDepth::Expert => write!(f, "expert"),
        }
    }
}

/// Structured LLM Architecture & Risk Review returned by the model
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LlmAnalysis {
    pub summary: String,
    pub risk_level: String,
    pub blast_radius: String,
    #[serde(default)]
    pub key_warnings: Vec<String>,
    #[serde(default)]
    pub resources: HashMap<String, ResourceInsight>,
}

/// Execution metrics captured during LLM inference
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExecutionMetrics {
    pub duration_ms: u128,
    pub prompt_tokens: Option<i32>,
    pub completion_tokens: Option<i32>,
    pub total_tokens: Option<i32>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ResourceInsight {
    pub risk: String,
    #[serde(default)]
    pub irreversible: bool,
    pub badge: String,
    pub note: String,
}

/// Recursively redacts sensitive values matching Terraform's before_sensitive / after_sensitive schema masks.
pub fn redact_sensitive_value(value: &mut serde_json::Value, mask: &serde_json::Value) {
    match mask {
        serde_json::Value::Bool(true) => {
            *value = serde_json::json!("(sensitive)");
        }
        serde_json::Value::Object(mask_map) => {
            if let Some(val_map) = value.as_object_mut() {
                for (k, sub_mask) in mask_map {
                    if let Some(v) = val_map.get_mut(k) {
                        redact_sensitive_value(v, sub_mask);
                    }
                }
            }
        }
        serde_json::Value::Array(mask_arr) => {
            if let Some(val_arr) = value.as_array_mut() {
                for (idx, sub_mask) in mask_arr.iter().enumerate() {
                    if let Some(v) = val_arr.get_mut(idx) {
                        redact_sensitive_value(v, sub_mask);
                    }
                }
            }
        }
        _ => {}
    }
}

/// Check if an attribute key name indicates sensitive credential data.
pub fn is_secret_attribute_name(key: &str) -> bool {
    let lower = key.to_lowercase();

    // 1. Explicitly ignore metadata/identifier suffixes that are safe to expose
    if lower.ends_with("_arn")
        || lower.ends_with("_id")
        || lower.ends_with("_name")
        || lower.ends_with("_uri")
        || lower.ends_with("_url")
        || lower.ends_with("_endpoint")
        || lower.ends_with("_type")
        || lower.ends_with("_algorithm")
        || lower.ends_with("_version")
        || lower.ends_with("_count")
        || lower.ends_with("_length")
        || lower.ends_with("_date")
        || lower.ends_with("_days")
        || lower.ends_with("_hours")
    {
        return false;
    }

    // 2. Passwords
    if lower == "password" || lower.contains("password") {
        return true;
    }

    // 3. Private keys & secrets (including AWS secret_access_key and Secrets Manager secret_string)
    if lower.contains("private_key")
        || lower.contains("secret_key")
        || lower.contains("secret_access_key")
        || lower.contains("access_secret")
        || lower.contains("client_secret")
        || lower.contains("shared_secret")
        || lower.contains("secret_string")
        || lower.contains("secret_binary")
        || lower == "secret"
        || lower.ends_with("_secret")
    {
        return true;
    }

    // 4. Tokens (refresh_token, access_token, auth_token, bearer_token, token)
    if lower == "token"
        || lower.ends_with("_token")
        || lower.contains("access_token")
        || lower.contains("refresh_token")
        || lower.contains("auth_token")
        || lower.contains("bearer_token")
    {
        return true;
    }

    // 5. API keys
    if lower == "api_key" || lower == "apikey" || lower.ends_with("_api_key") || lower.ends_with("_apikey") {
        return true;
    }

    // 6. Signing keys & certificates
    if lower.contains("signing_key") || lower.contains("ssh_private_key") {
        return true;
    }

    false
}

/// Defense-in-depth: Redact attributes whose keys indicate sensitive credentials, even if unmasked.
pub fn redact_common_secret_keys(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map.iter_mut() {
                if is_secret_attribute_name(k) {
                    *v = serde_json::json!("(sensitive)");
                } else {
                    redact_common_secret_keys(v);
                }
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr {
                redact_common_secret_keys(item);
            }
        }
        _ => {}
    }
}

/// Extracts changed resources directly from Terraform's resource_changes array.
/// Discards untouched resources where actions is empty, ["no-op"], or ["read"].
/// Redacts all sensitive attributes using before_sensitive and after_sensitive masks.
pub fn extract_changed_resources(plan_val: &serde_json::Value) -> (usize, Vec<serde_json::Value>) {
    let empty_vec = vec![];
    let resources = plan_val
        .get("resource_changes")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty_vec);

    let mut changed = Vec::new();

    for r in resources {
        let actions = r
            .get("change")
            .and_then(|c| c.get("actions"))
            .and_then(|a| a.as_array());

        // Terraform semantics: an empty actions array or only ["no-op"] / ["read"] is a no-op
        let is_noop = match actions {
            Some(acts) => {
                acts.is_empty()
                    || acts.iter().all(|a| {
                        let s = a.as_str().unwrap_or("");
                        s == "no-op" || s == "read"
                    })
            }
            None => true,
        };

        if is_noop {
            continue;
        }

        let address = r.get("address").and_then(|v| v.as_str()).unwrap_or("unknown");
        let r_type = r.get("type").and_then(|v| v.as_str()).unwrap_or("unknown");
        let change = r.get("change");

        let action_strs: Vec<&str> = actions
            .map(|acts| acts.iter().filter_map(|a| a.as_str()).collect())
            .unwrap_or_default();

        let before_sensitive = change.and_then(|c| c.get("before_sensitive"));
        let after_sensitive = change.and_then(|c| c.get("after_sensitive"));

        let mut before = change.and_then(|c| c.get("before")).cloned();
        let mut after = change.and_then(|c| c.get("after")).cloned();

        if let Some(b) = &mut before {
            if let Some(mask) = before_sensitive {
                redact_sensitive_value(b, mask);
            }
            redact_common_secret_keys(b);
        }

        if let Some(a) = &mut after {
            if let Some(mask) = after_sensitive {
                redact_sensitive_value(a, mask);
            }
            redact_common_secret_keys(a);
        }

        let mut item = serde_json::Map::new();
        item.insert("address".into(), serde_json::json!(address));
        item.insert("type".into(), serde_json::json!(r_type));
        item.insert("actions".into(), serde_json::json!(action_strs));
        if let Some(b) = before {
            item.insert("before".into(), b);
        }
        if let Some(a) = after {
            item.insert("after".into(), a);
        }

        changed.push(serde_json::Value::Object(item));
    }

    (resources.len(), changed)
}

/// Extracts the full planned architecture from planned_values, redacting sensitive attributes.
pub fn extract_full_architecture(plan_val: &serde_json::Value) -> (usize, Vec<serde_json::Value>) {
    let mut sensitive_masks: HashMap<String, serde_json::Value> = HashMap::new();
    if let Some(rc) = plan_val.get("resource_changes").and_then(|v| v.as_array()) {
        for r in rc {
            if let (Some(addr), Some(mask)) = (
                r.get("address").and_then(|v| v.as_str()),
                r.get("change").and_then(|c| c.get("after_sensitive")),
            ) {
                sensitive_masks.insert(addr.to_string(), mask.clone());
            }
        }
    }

    fn collect_module_resources(
        module: &serde_json::Value,
        masks: &HashMap<String, serde_json::Value>,
        out: &mut Vec<serde_json::Value>,
    ) {
        if let Some(resources) = module.get("resources").and_then(|r| r.as_array()) {
            for r in resources {
                let address = r.get("address").and_then(|v| v.as_str()).unwrap_or("unknown");
                let r_type = r.get("type").and_then(|v| v.as_str()).unwrap_or("unknown");
                let values = r.get("values");

                let mut item = serde_json::Map::new();
                item.insert("address".into(), serde_json::json!(address));
                item.insert("type".into(), serde_json::json!(r_type));
                if let Some(v) = values {
                    let mut val_cloned = v.clone();
                    // 1. Redact using the resource's own sensitive_values mask in planned_values
                    if let Some(res_mask) = r.get("sensitive_values") {
                        redact_sensitive_value(&mut val_cloned, res_mask);
                    }
                    // 2. Redact using after_sensitive mask from resource_changes if available
                    if let Some(mask) = masks.get(address) {
                        redact_sensitive_value(&mut val_cloned, mask);
                    }
                    // 3. Defense-in-depth: redact common secret keys
                    redact_common_secret_keys(&mut val_cloned);
                    item.insert("values".into(), val_cloned);
                }
                out.push(serde_json::Value::Object(item));
            }
        }
        if let Some(child_modules) = module.get("child_modules").and_then(|cm| cm.as_array()) {
            for cm in child_modules {
                collect_module_resources(cm, masks, out);
            }
        }
    }

    let mut out = Vec::new();
    if let Some(root_module) = plan_val.get("planned_values").and_then(|pv| pv.get("root_module")) {
        collect_module_resources(root_module, &sensitive_masks, &mut out);
    }
    let total = out.len();
    (total, out)
}

/// Parses a provider string into a supported genai AdapterKind.
pub fn parse_adapter_kind(s: &str) -> Option<AdapterKind> {
    match s.trim().to_lowercase().as_str() {
        "openai" => Some(AdapterKind::OpenAI),
        "ollama" => Some(AdapterKind::Ollama),
        "anthropic" => Some(AdapterKind::Anthropic),
        "cohere" => Some(AdapterKind::Cohere),
        "gemini" => Some(AdapterKind::Gemini),
        "groq" => Some(AdapterKind::Groq),
        "xai" => Some(AdapterKind::Xai),
        "deepseek" => Some(AdapterKind::DeepSeek),
        _ => None,
    }
}

/// Resolves the explicit LLM model and optional provider from CLI args or TFVIEW_MODEL / TFVIEW_PROVIDER.
/// Strict: No silent defaults or guessing.
pub fn resolve_model(
    provider: Option<&str>,
    explicit_model: Option<&str>,
) -> Result<(Option<AdapterKind>, String)> {
    let raw_model = match explicit_model {
        Some(m) if !m.trim().is_empty() => m.trim(),
        _ => {
            bail!(
                "No LLM model specified.\n\
                 Please specify a model using '--model <MODEL>' (e.g. '--model gpt-4o-mini', '--model claude-3-5-haiku-latest', or '--model ollama::glm-4.7-flash:latest') \
                 or set the 'TFVIEW_MODEL' environment variable."
            );
        }
    };

    let (mut detected_provider, clean_model) =
        if let Some((prov, m)) = raw_model.split_once("::").or_else(|| raw_model.split_once('/')) {
            if let Some(kind) = parse_adapter_kind(prov) {
                (Some(kind), m.to_string())
            } else {
                (None, raw_model.to_string())
            }
        } else {
            (None, raw_model.to_string())
        };

    if let Some(p) = provider {
        if let Some(kind) = parse_adapter_kind(p) {
            detected_provider = Some(kind);
        } else {
            bail!(
                "Unknown provider '{}'. Supported providers: openai, anthropic, gemini, ollama, groq, deepseek, cohere, xai.",
                p
            );
        }
    }

    Ok((detected_provider, clean_model))
}

/// Normalizes an endpoint URL ensuring proper trailing slashes and '/v1' path for Ollama/OpenAI APIs.
pub fn normalize_endpoint(url: &str, adapter: Option<AdapterKind>) -> String {
    let mut trimmed = url.trim().trim_end_matches('/').to_string();
    if adapter == Some(AdapterKind::Ollama) && !trimmed.ends_with("/v1") {
        trimmed.push_str("/v1");
    }
    trimmed.push('/');
    trimmed
}

/// Builds a genai::Client configured cleanly via ClientBuilder resolvers (no global env mutation).
pub fn build_genai_client(
    target_adapter: Option<AdapterKind>,
    api_key: Option<String>,
    endpoint: Option<String>,
) -> Client {
    let mut builder = Client::builder();

    if let Some(target_adapter) = target_adapter {
        builder = builder.with_model_mapper_fn(move |model_iden: ModelIden| {
            Ok(ModelIden::new(target_adapter, model_iden.model_name))
        });
    }

    if let Some(key) = api_key {
        builder = builder.with_auth_resolver_fn(move |_model_iden: ModelIden| {
            Ok(Some(AuthData::from_single(key.clone())))
        });
    }

    let ollama_host = env::var("OLLAMA_HOST").ok();
    if endpoint.is_some() || ollama_host.is_some() {
        let ep = endpoint.clone();
        let o_host = ollama_host.clone();
        builder = builder.with_service_target_resolver_fn(move |mut target: ServiceTarget| {
            let active_adapter = target_adapter.unwrap_or(target.model.adapter_kind);
            if let Some(ref ep_url) = ep {
                target.endpoint = Endpoint::from_owned(normalize_endpoint(ep_url, Some(active_adapter)));
            } else if active_adapter == AdapterKind::Ollama {
                if let Some(ref host) = o_host {
                    target.endpoint = Endpoint::from_owned(normalize_endpoint(host, Some(AdapterKind::Ollama)));
                }
            }
            Ok(target)
        });
    }

    builder.build()
}

const PROMPT_CHANGES_STANDARD: &str = include_str!("../prompts/changes_standard.md");
const PROMPT_CHANGES_EXPERT: &str = include_str!("../prompts/changes_expert.md");
const PROMPT_FULL_STANDARD: &str = include_str!("../prompts/full_standard.md");
const PROMPT_FULL_EXPERT: &str = include_str!("../prompts/full_expert.md");

/// Builds the system prompt tailored to the requested review scope and depth.
pub fn build_system_prompt(scope: ReviewScope, depth: ReviewDepth) -> &'static str {
    match (scope, depth) {
        (ReviewScope::Changes, ReviewDepth::Standard) => PROMPT_CHANGES_STANDARD,
        (ReviewScope::Changes, ReviewDepth::Expert) => PROMPT_CHANGES_EXPERT,
        (ReviewScope::Full, ReviewDepth::Standard) => PROMPT_FULL_STANDARD,
        (ReviewScope::Full, ReviewDepth::Expert) => PROMPT_FULL_EXPERT,
    }
}

/// Slices clean JSON text by stripping markdown code fences or extracting the outermost `{ ... }`.
pub fn extract_json_str(raw: &str) -> &str {
    let trimmed = raw.trim();

    // 1. Look for ```json ... ``` or ``` ... ```
    if let Some(start_fence) = trimmed.find("```") {
        let after_start = &trimmed[start_fence + 3..];
        let content_start = if let Some(newline_pos) = after_start.find('\n') {
            newline_pos + 1
        } else {
            0
        };
        let inner = &after_start[content_start..];
        if let Some(end_fence) = inner.rfind("```") {
            let fence_content = inner[..end_fence].trim();
            if let (Some(first_brace), Some(last_brace)) = (fence_content.find('{'), fence_content.rfind('}')) {
                if first_brace <= last_brace {
                    return &fence_content[first_brace..=last_brace];
                }
            }
            return fence_content;
        }
    }

    // 2. Fall back to finding the outermost '{' and '}'
    if let (Some(first_brace), Some(last_brace)) = (trimmed.find('{'), trimmed.rfind('}')) {
        if first_brace <= last_brace {
            return &trimmed[first_brace..=last_brace];
        }
    }

    trimmed
}

/// Maximum number of resources sent to the LLM to prevent context overflow or provider 400s.
pub const MAX_RESOURCES_ANALYZED: usize = 150;

/// Maximum payload size in bytes (~250 KB / ~60,000 tokens) to guard against context limits
/// even when analyzing large resources with complex configuration state (e.g. EKS/RDS).
pub const MAX_PAYLOAD_BYTES: usize = 250_000;

/// Prioritizes resources by operational impact (delete/replace > update > create)
/// or architectural criticality (IAM, databases, clusters, networking) when actions are not present.
pub fn prioritize_resources(mut resources: Vec<serde_json::Value>, max_count: usize) -> Vec<serde_json::Value> {
    if resources.len() <= max_count {
        return resources;
    }

    fn resource_impact_weight(r: &serde_json::Value) -> u8 {
        let actions = r.get("actions").and_then(|a| a.as_array());
        if let Some(acts) = actions {
            let has_action = |act: &str| -> bool {
                acts.iter().any(|v| v.as_str() == Some(act))
            };
            if has_action("delete") && has_action("create") {
                return 0; // Replacement: highest operational risk
            } else if has_action("delete") {
                return 1; // Deletion: high operational risk
            } else if has_action("update") {
                return 2; // Modification: medium operational risk
            } else if has_action("create") {
                return 3; // Addition: lower operational risk
            }
        }

        // When actions are absent (e.g. --scope full on planned_values), rank by architectural criticality
        let r_type = r.get("type").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
        if r_type.contains("iam_")
            || r_type.contains("kms_")
            || r_type.contains("secretsmanager_")
            || r_type.contains("cognito_")
        {
            10 // Identity, encryption & access management
        } else if r_type.contains("db_")
            || r_type.contains("rds_")
            || r_type.contains("dynamodb_")
            || r_type.contains("s3_bucket")
            || r_type.contains("elasticache_")
        {
            11 // Primary persistent data stores & buckets
        } else if r_type.contains("eks_")
            || r_type.contains("ecs_")
            || r_type.contains("instance")
            || r_type.contains("autoscaling_group")
            || r_type.contains("lambda_")
        {
            12 // Core compute & container orchestration
        } else if r_type.contains("vpc")
            || r_type.contains("security_group")
            || r_type.contains("subnet")
            || r_type.contains("route_table")
            || r_type.contains("lb")
            || r_type.contains("alb")
            || r_type.contains("internet_gateway")
            || r_type.contains("nat_gateway")
            || r_type.contains("cloudfront_")
            || r_type.contains("route53_")
        {
            13 // Core network boundary & ingress/egress
        } else {
            20 // Peripheral / auxiliary resources
        }
    }

    resources.sort_by_key(resource_impact_weight);
    resources.truncate(max_count);
    resources
}

/// Analyze the plan with an LLM via genai using calibrated risk guidelines
pub async fn run_llm_analysis(
    client: &Client,
    model: &str,
    resources: &[serde_json::Value],
    scope: ReviewScope,
    depth: ReviewDepth,
    temperature: Option<f64>,
) -> Result<(LlmAnalysis, ExecutionMetrics)> {
    if resources.is_empty() {
        return Ok((
            LlmAnalysis {
                summary: "No resources found to analyze for this plan.".to_string(),
                risk_level: "LOW".to_string(),
                blast_radius: "None (zero resources)".to_string(),
                key_warnings: vec![],
                resources: HashMap::new(),
            },
            ExecutionMetrics {
                duration_ms: 0,
                prompt_tokens: Some(0),
                completion_tokens: Some(0),
                total_tokens: Some(0),
            },
        ));
    }

    // Apply resource cap with prioritization if the plan is very large
    let total_resources = resources.len();
    let mut target_resources = if total_resources > MAX_RESOURCES_ANALYZED {
        prioritize_resources(resources.to_vec(), MAX_RESOURCES_ANALYZED)
    } else {
        resources.to_vec()
    };

    // Size guard: if the serialized payload exceeds MAX_PAYLOAD_BYTES, prune lower-priority items
    let mut payload_json = serde_json::to_string_pretty(&target_resources)?;
    while payload_json.len() > MAX_PAYLOAD_BYTES && target_resources.len() > 10 {
        let new_len = (target_resources.len() * 3) / 4;
        target_resources.truncate(new_len);
        payload_json = serde_json::to_string_pretty(&target_resources)?;
    }

    let is_truncated = target_resources.len() < total_resources;
    if is_truncated {
        eprintln!(
            "==> [tfview] Notice: Plan contains {} resources. Analyzing {} highest-impact resources to respect model context constraints.",
            total_resources,
            target_resources.len()
        );
    }

    let system_prompt = build_system_prompt(scope, depth);

    // Keep the model honest about truncation so summary and whole-plan risk rating remain calibrated
    let user_content = if is_truncated {
        let note = match scope {
            ReviewScope::Changes => format!(
                "\n\n[Note to reviewer: This plan contains {} total changed resources. Showing the {} highest-impact resources by operational risk (replacements, deletions, updates) due to context size limits. Calibrate your summary, whole-plan risk rating, and blast radius accordingly.]",
                total_resources,
                target_resources.len()
            ),
            ReviewScope::Full => format!(
                "\n\n[Note to reviewer: Architecture contains {} total planned resources. Showing {} prioritized core infrastructure resources (IAM, databases, clusters, networking) due to context size limits. Calibrate your summary, whole-plan risk rating, and blast radius accordingly.]",
                total_resources,
                target_resources.len()
            ),
        };
        format!("{}{}", payload_json, note)
    } else {
        payload_json.clone()
    };

    let chat_req = ChatRequest::new(vec![
        ChatMessage::system(system_prompt),
        ChatMessage::user(user_content.clone()),
    ]);

    let start_time = std::time::Instant::now();

    // First attempt: Request JSON mode via ChatOptions
    // Options for every call to the model; JSON mode is added only to the first
    let mut base_options = ChatOptions::default();
    if let Some(t) = temperature {
        base_options = base_options.with_temperature(t);
    }
    let json_options = base_options.clone().with_response_format(ChatResponseFormat::JsonMode);
    let exec_res = client.exec_chat(model, chat_req.clone(), Some(&json_options)).await;

    // Fallback: If provider rejects JsonMode, retry without options ONLY if the error indicates unsupported format.
    // Auth failures, rate limits, bad model names, or network errors fail immediately with the original error.
    let response = match exec_res {
        Ok(resp) => resp,
        Err(err) => {
            let err_msg = err.to_string();
            let lower = err_msg.to_lowercase();
            let is_format_unsupported = lower.contains("response_format")
                || lower.contains("json_mode")
                || lower.contains("json mode")
                || lower.contains("unsupported parameter")
                || (lower.contains("format") && lower.contains("not supported"));

            if is_format_unsupported {
                eprintln!("==> [tfview] Notice: Provider or model does not support JsonMode, retrying with standard prompt format...");
                client
                    .exec_chat(model, chat_req.clone(), Some(&base_options))
                    .await
                    .with_context(|| format!("Failed calling LLM model '{}' via genai after JsonMode fallback: {}", model, err_msg))?
            } else {
                return Err(anyhow::Error::new(err).context(format!(
                    "Failed calling LLM model '{}' via genai. Verify the model name, credentials, and API accessibility.",
                    model
                )));
            }
        }
    };

    let duration_ms = start_time.elapsed().as_millis();
    let metrics = ExecutionMetrics {
        duration_ms,
        prompt_tokens: response.usage.prompt_tokens,
        completion_tokens: response.usage.completion_tokens,
        total_tokens: response.usage.total_tokens,
    };

    let raw_text = response
        .content_text_as_str()
        .context("LLM returned empty response")?;

    let cleaned_text = extract_json_str(raw_text);

    let analysis: LlmAnalysis = match serde_json::from_str(cleaned_text) {
        Ok(a) => a,
        Err(parse_err) => {
            // Single retry on parse failure with strict correction prompt
            eprintln!("==> [tfview] LLM response contained formatting noise, requesting clean JSON retry...");
            let retry_req = ChatRequest::new(vec![
                ChatMessage::system(system_prompt),
                ChatMessage::user(user_content),
                ChatMessage::assistant(raw_text.to_string()),
                ChatMessage::user(
                    "Your previous response was not valid JSON. Please return ONLY a valid JSON object matching the required schema with no markdown formatting, fences, or surrounding text.".to_string(),
                ),
            ]);

            let retry_resp = client
                .exec_chat(model, retry_req, Some(&base_options))
                .await
                .with_context(|| "Failed executing LLM retry request.")?;

            let retry_text = retry_resp
                .content_text_as_str()
                .context("LLM returned empty retry response")?;

            let retry_cleaned = extract_json_str(retry_text);
            serde_json::from_str(retry_cleaned).with_context(|| {
                format!(
                    "Failed to parse LLM response as JSON after retry.\nInitial error: {}\nRaw response:\n{}",
                    parse_err, raw_text
                )
            })?
        }
    };

    Ok((analysis, metrics))
}

fn format_count(n: i32) -> String {
    let s = n.to_string();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    let len = s.len();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (len - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// Print formatted review summary to the console terminal
pub fn print_terminal_summary(
    analysis: &LlmAnalysis,
    metrics: &ExecutionMetrics,
    provider: &str,
    model: &str,
    scope: ReviewScope,
    depth: ReviewDepth,
) {
    eprintln!("\n╭─────────────────────────────────────────────────────────────╮");
    eprintln!("│                ARCHITECTURE & RISK REVIEW                   │");
    eprintln!("╰─────────────────────────────────────────────────────────────╯");
    eprintln!("Provider:      {}", provider);
    eprintln!("Model:         {}", model);
    eprintln!("Scope / Depth: {} / {}", scope, depth);
    eprintln!("Risk Level:    {}", analysis.risk_level);
    eprintln!("Blast Radius:  {}", analysis.blast_radius);

    let sec = metrics.duration_ms as f64 / 1000.0;
    let tokens_display = match (metrics.prompt_tokens, metrics.completion_tokens, metrics.total_tokens) {
        (Some(p), Some(c), Some(t)) => format!("Tokens: {} total ({} input, {} output)", format_count(t), format_count(p), format_count(c)),
        _ => "Tokens: not reported by provider".to_string(),
    };
    eprintln!("Review Time:   {:.2}s | {}", sec, tokens_display);
    eprintln!("\nSummary:\n  {}", analysis.summary);

    if !analysis.key_warnings.is_empty() {
        eprintln!("\nKey Warnings:");
        for w in &analysis.key_warnings {
            eprintln!("  • {}", w);
        }
    }

    if !analysis.resources.is_empty() {
        eprintln!("\nResource Insights:");
        for (addr, insight) in &analysis.resources {
            let irrev = if insight.irreversible { " [IRREVERSIBLE]" } else { "" };
            eprintln!("  • {} [{} - {}]{}: {}", addr, insight.risk, insight.badge, irrev, insight.note);
        }
    }
    eprintln!();
}

/// Enriches a Terraform plan JSON value by embedding annotations.llm_review at the root.
pub fn enrich_plan_with_llm(
    plan_val: &mut serde_json::Value,
    analysis: &LlmAnalysis,
    metrics: &ExecutionMetrics,
    provider: &str,
    model: &str,
    scope: ReviewScope,
    depth: ReviewDepth,
) {
    let review_obj = serde_json::json!({
        "provider": provider,
        "model": model,
        "scope": scope.to_string(),
        "depth": depth.to_string(),
        "metrics": {
            "duration_ms": metrics.duration_ms,
            "prompt_tokens": metrics.prompt_tokens,
            "completion_tokens": metrics.completion_tokens,
            "total_tokens": metrics.total_tokens,
        },
        "summary": analysis.summary,
        "risk_level": analysis.risk_level,
        "blast_radius": analysis.blast_radius,
        "key_warnings": analysis.key_warnings,
        "resources": analysis.resources,
    });

    if let Some(obj) = plan_val.as_object_mut() {
        let annotations = obj.entry("annotations").or_insert_with(|| serde_json::json!({}));
        if let Some(ann_obj) = annotations.as_object_mut() {
            ann_obj.insert("llm_review".into(), review_obj);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_adapter_kind() {
        assert_eq!(parse_adapter_kind("openai"), Some(AdapterKind::OpenAI));
        assert_eq!(parse_adapter_kind("OpenAI"), Some(AdapterKind::OpenAI));
        assert_eq!(parse_adapter_kind("ollama"), Some(AdapterKind::Ollama));
        assert_eq!(parse_adapter_kind("Anthropic"), Some(AdapterKind::Anthropic));
        assert_eq!(parse_adapter_kind("cohere"), Some(AdapterKind::Cohere));
        assert_eq!(parse_adapter_kind("gemini"), Some(AdapterKind::Gemini));
        assert_eq!(parse_adapter_kind("groq"), Some(AdapterKind::Groq));
        assert_eq!(parse_adapter_kind("xai"), Some(AdapterKind::Xai));
        assert_eq!(parse_adapter_kind("deepseek"), Some(AdapterKind::DeepSeek));
        assert_eq!(parse_adapter_kind("unsupported"), None);
    }

    #[test]
    fn test_resolve_model_bare() {
        let (prov, model) = resolve_model(None, Some("gpt-4o-mini")).unwrap();
        assert_eq!(prov, None);
        assert_eq!(model, "gpt-4o-mini");
    }

    #[test]
    fn test_resolve_model_prefix() {
        let (prov, model) = resolve_model(None, Some("ollama::glm-4.7-flash:latest")).unwrap();
        assert_eq!(prov, Some(AdapterKind::Ollama));
        assert_eq!(model, "glm-4.7-flash:latest");

        let (prov2, model2) = resolve_model(None, Some("anthropic/claude-3-5-sonnet-latest")).unwrap();
        assert_eq!(prov2, Some(AdapterKind::Anthropic));
        assert_eq!(model2, "claude-3-5-sonnet-latest");
    }

    #[test]
    fn test_resolve_model_explicit_provider() {
        let (prov, model) = resolve_model(Some("groq"), Some("llama-3.1-70b")).unwrap();
        assert_eq!(prov, Some(AdapterKind::Groq));
        assert_eq!(model, "llama-3.1-70b");
    }

    #[test]
    fn test_resolve_model_unknown_provider() {
        let res = resolve_model(Some("unknown-provider"), Some("model-1"));
        assert!(res.is_err());
        assert!(res.unwrap_err().to_string().contains("Unknown provider 'unknown-provider'"));
    }

    #[test]
    fn test_resolve_model_empty() {
        let res = resolve_model(None, None);
        assert!(res.is_err());
        assert!(res.unwrap_err().to_string().contains("No LLM model specified"));
    }

    #[test]
    fn test_normalize_endpoint() {
        assert_eq!(
            normalize_endpoint("http://localhost:11434", Some(AdapterKind::Ollama)),
            "http://localhost:11434/v1/"
        );
        assert_eq!(
            normalize_endpoint("http://localhost:11434/v1", Some(AdapterKind::Ollama)),
            "http://localhost:11434/v1/"
        );
        assert_eq!(
            normalize_endpoint("https://api.openai.com/v1", Some(AdapterKind::OpenAI)),
            "https://api.openai.com/v1/"
        );
        assert_eq!(
            normalize_endpoint("https://my-proxy.internal:8080/v1/", None),
            "https://my-proxy.internal:8080/v1/"
        );
    }

    #[test]
    fn test_redact_sensitive_value() {
        let mut val = serde_json::json!({
            "name": "db-instance",
            "password": "super-secret-password-123",
            "nested": {
                "token": "api-token-abc",
                "public_attr": "ok"
            },
            "credentials_list": ["secret1", "public1"]
        });

        let mask = serde_json::json!({
            "password": true,
            "nested": {
                "token": true
            },
            "credentials_list": [true, false]
        });

        redact_sensitive_value(&mut val, &mask);

        assert_eq!(val["name"], "db-instance");
        assert_eq!(val["password"], "(sensitive)");
        assert_eq!(val["nested"]["token"], "(sensitive)");
        assert_eq!(val["nested"]["public_attr"], "ok");
        assert_eq!(val["credentials_list"][0], "(sensitive)");
        assert_eq!(val["credentials_list"][1], "public1");
    }

    #[test]
    fn test_redact_common_secret_keys() {
        let mut val = serde_json::json!({
            "admin_password": "plain-text-pwd",
            "private_key": "-----BEGIN RSA PRIVATE KEY-----...",
            "database_port": 5432,
            "secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            "secret_string": "{\"app_secret\": 123}",
            "refresh_token": "oauth2-long-lived-refresh-token",
            "api_key": "prod-api-key-value",
            "secret": "my-secret-value",
            "token": "bearer-token-val",
            "secret_id": "arn:aws:secretsmanager:us-east-1:123456789012:secret:mysecret",
            "secret_arn": "arn:aws:secretsmanager:us-east-1:123456789012:secret:mysecret-AbCdEf",
            "token_type": "Bearer",
            "kms_key_id": "12345678-1234-1234-1234-123456789012"
        });

        redact_common_secret_keys(&mut val);

        assert_eq!(val["admin_password"], "(sensitive)");
        assert_eq!(val["private_key"], "(sensitive)");
        assert_eq!(val["secret_access_key"], "(sensitive)");
        assert_eq!(val["secret_string"], "(sensitive)");
        assert_eq!(val["refresh_token"], "(sensitive)");
        assert_eq!(val["api_key"], "(sensitive)");
        assert_eq!(val["secret"], "(sensitive)");
        assert_eq!(val["token"], "(sensitive)");

        // Safe identifiers must not be redacted
        assert_eq!(val["database_port"], 5432);
        assert_eq!(val["secret_id"], "arn:aws:secretsmanager:us-east-1:123456789012:secret:mysecret");
        assert_eq!(val["secret_arn"], "arn:aws:secretsmanager:us-east-1:123456789012:secret:mysecret-AbCdEf");
        assert_eq!(val["token_type"], "Bearer");
        assert_eq!(val["kms_key_id"], "12345678-1234-1234-1234-123456789012");
    }

    #[test]
    fn test_extract_changed_resources_redaction() {
        let plan_json = serde_json::json!({
            "resource_changes": [
                {
                    "address": "aws_db_instance.db",
                    "type": "aws_db_instance",
                    "change": {
                        "actions": ["update"],
                        "before": {
                            "allocated_storage": 20,
                            "master_password": "old_secret_pwd"
                        },
                        "after": {
                            "allocated_storage": 40,
                            "master_password": "new_secret_pwd"
                        },
                        "before_sensitive": {
                            "master_password": true
                        },
                        "after_sensitive": {
                            "master_password": true
                        }
                    }
                },
                {
                    "address": "aws_vpc.main",
                    "type": "aws_vpc",
                    "change": {
                        "actions": ["no-op"]
                    }
                }
            ]
        });

        let (tot, changed) = extract_changed_resources(&plan_json);
        assert_eq!(tot, 2);
        assert_eq!(changed.len(), 1);

        let db = &changed[0];
        assert_eq!(db["address"], "aws_db_instance.db");
        assert_eq!(db["before"]["master_password"], "(sensitive)");
        assert_eq!(db["after"]["master_password"], "(sensitive)");
        assert_eq!(db["after"]["allocated_storage"], 40);
    }

    #[test]
    fn test_extract_full_architecture_redaction() {
        let plan_json = serde_json::json!({
            "resource_changes": [
                {
                    "address": "aws_db_instance.main",
                    "change": {
                        "after_sensitive": {
                            "password": true
                        }
                    }
                }
            ],
            "planned_values": {
                "root_module": {
                    "resources": [
                        {
                            "address": "aws_db_instance.main",
                            "type": "aws_db_instance",
                            "values": {
                                "instance_class": "db.t3.micro",
                                "password": "supersecretpassword"
                            }
                        }
                    ]
                }
            }
        });

        let (tot, all_res) = extract_full_architecture(&plan_json);
        assert_eq!(tot, 1);
        assert_eq!(all_res.len(), 1);
        assert_eq!(all_res[0]["values"]["instance_class"], "db.t3.micro");
        assert_eq!(all_res[0]["values"]["password"], "(sensitive)");
    }

    #[test]
    fn test_extract_full_architecture_resource_sensitive_values_mask() {
        // Plan where resource_changes has NO entry for the resource, but planned_values has sensitive_values mask
        let plan_json = serde_json::json!({
            "resource_changes": [],
            "planned_values": {
                "root_module": {
                    "resources": [
                        {
                            "address": "custom_provider_service.item",
                            "type": "custom_provider_service",
                            "values": {
                                "public_endpoint": "https://api.example.com",
                                "custom_webhook_payload": "super-secret-hmac-data"
                            },
                            "sensitive_values": {
                                "custom_webhook_payload": true
                            }
                        }
                    ]
                }
            }
        });

        let (tot, all_res) = extract_full_architecture(&plan_json);
        assert_eq!(tot, 1);
        assert_eq!(all_res[0]["values"]["public_endpoint"], "https://api.example.com");
        // Must be redacted via resource sensitive_values mask even though key name is not in common list
        assert_eq!(all_res[0]["values"]["custom_webhook_payload"], "(sensitive)");
    }

    #[test]
    fn test_extract_json_str() {
        // Plain JSON
        let plain = r#"{"summary": "ok", "risk_level": "LOW"}"#;
        assert_eq!(extract_json_str(plain), plain);

        // JSON inside ```json ... ``` code fence
        let fenced = "```json\n{\"summary\": \"ok\"}\n```";
        assert_eq!(extract_json_str(fenced), "{\"summary\": \"ok\"}");

        // JSON with conversational preamble and postamble
        let conversational = "Here is the analysis you requested:\n```json\n{\"summary\": \"done\"}\n```\nHope this helps!";
        assert_eq!(extract_json_str(conversational), "{\"summary\": \"done\"}");

        // JSON without fences but with preamble
        let raw_with_preamble = "Analysis result:\n{\"risk_level\": \"HIGH\"}\nEnd of response.";
        assert_eq!(extract_json_str(raw_with_preamble), "{\"risk_level\": \"HIGH\"}");
    }

    #[test]
    fn test_prioritize_resources() {
        let resources = vec![
            serde_json::json!({"address": "res.create", "actions": ["create"]}),
            serde_json::json!({"address": "res.delete", "actions": ["delete"]}),
            serde_json::json!({"address": "res.replace", "actions": ["delete", "create"]}),
            serde_json::json!({"address": "res.update", "actions": ["update"]}),
        ];

        let prioritized = prioritize_resources(resources, 2);
        assert_eq!(prioritized.len(), 2);
        assert_eq!(prioritized[0]["address"], "res.replace");
        assert_eq!(prioritized[1]["address"], "res.delete");
    }

    #[test]
    fn test_prioritize_resources_full_scope() {
        // Under --scope full, resources do not have an "actions" key
        let resources = vec![
            serde_json::json!({"address": "aws_cloudwatch_metric_alarm.high_cpu", "type": "aws_cloudwatch_metric_alarm"}),
            serde_json::json!({"address": "aws_iam_role.admin", "type": "aws_iam_role"}),
            serde_json::json!({"address": "aws_route_table_association.assoc", "type": "aws_route_table_association"}),
            serde_json::json!({"address": "aws_db_instance.primary", "type": "aws_db_instance"}),
            serde_json::json!({"address": "aws_eks_cluster.prod", "type": "aws_eks_cluster"}),
        ];

        let prioritized = prioritize_resources(resources, 3);
        assert_eq!(prioritized.len(), 3);
        // IAM (weight 10) > RDS (weight 11) > EKS (weight 12)
        assert_eq!(prioritized[0]["address"], "aws_iam_role.admin");
        assert_eq!(prioritized[1]["address"], "aws_db_instance.primary");
        assert_eq!(prioritized[2]["address"], "aws_eks_cluster.prod");
    }

    #[test]
    fn test_is_secret_attribute_name() {
        assert!(is_secret_attribute_name("master_password"));
        assert!(is_secret_attribute_name("secret_access_key"));
        assert!(is_secret_attribute_name("secret_string"));
        assert!(is_secret_attribute_name("refresh_token"));
        assert!(is_secret_attribute_name("access_token"));
        assert!(is_secret_attribute_name("api_key"));
        assert!(is_secret_attribute_name("secret"));
        assert!(is_secret_attribute_name("token"));

        assert!(!is_secret_attribute_name("secret_id"));
        assert!(!is_secret_attribute_name("secret_arn"));
        assert!(!is_secret_attribute_name("secret_name"));
        assert!(!is_secret_attribute_name("token_type"));
        assert!(!is_secret_attribute_name("kms_key_id"));
        assert!(!is_secret_attribute_name("public_key"));
    }
}
