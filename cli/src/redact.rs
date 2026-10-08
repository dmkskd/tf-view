//! Removes secret values from a `terraform show -json` plan before it is embedded in a report.
//! Keeps the plan's shape so the viewer still works. Mirrors redactPlan() in demo/atlantis/shared/inject.js.
//!
//! Covers resource and output changes, drift, planned and prior state, sensitive variables (value and
//! default), and the literals written in config for attributes that turned out sensitive.
//! Not covered: secrets that Terraform does not mark sensitive.

use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

const REDACTED: &str = "(sensitive)";

/// Terraform mirrors a value's shape in its `*_sensitive` mask: `true` marks a sensitive leaf,
/// objects and arrays recurse.
fn redact(value: &mut Value, mask: &Value) {
    match mask {
        Value::Bool(true) => *value = json!(REDACTED),
        Value::Object(m) => {
            if let Some(obj) = value.as_object_mut() {
                for (k, sub) in m {
                    if let Some(v) = obj.get_mut(k) {
                        redact(v, sub);
                    }
                }
            }
        }
        Value::Array(m) => {
            if let Some(arr) = value.as_array_mut() {
                for (v, sub) in arr.iter_mut().zip(m) {
                    redact(v, sub);
                }
            }
        }
        _ => {}
    }
}

fn has_secret(mask: &Value) -> bool {
    match mask {
        Value::Bool(b) => *b,
        Value::Object(m) => m.values().any(has_secret),
        Value::Array(a) => a.iter().any(has_secret),
        _ => false,
    }
}

/// Redacts `before` and `after` of a change object by its `before_sensitive` / `after_sensitive` masks.
fn redact_change(change: &mut Value) {
    for (field, mask_field) in [("before", "before_sensitive"), ("after", "after_sensitive")] {
        let mask = change.get(mask_field).cloned().unwrap_or(Value::Null);
        if let Some(v) = change.get_mut(field) {
            redact(v, &mask);
        }
    }
}

/// An address without its module and resource indexes: `aws_x.y["a"]` -> `aws_x.y`.
/// Keys are quoted strings and may contain `]` or `[`, so brackets inside quotes do not count.
fn normalize(addr: &str) -> String {
    let mut out = String::with_capacity(addr.len());
    let (mut depth, mut in_str, mut escaped) = (0, false, false);
    for c in addr.chars() {
        if depth > 0 {
            if in_str {
                match (escaped, c) {
                    (true, _) => escaped = false,
                    (false, '\\') => escaped = true,
                    (false, '"') => in_str = false,
                    _ => {}
                }
            } else {
                match c {
                    '"' => in_str = true,
                    '[' => depth += 1,
                    ']' => depth -= 1,
                    _ => {}
                }
            }
        } else if c == '[' {
            depth = 1;
        } else {
            out.push(c);
        }
    }
    out
}

/// Replaces every literal under a config expression. References (`references`) are addresses, not
/// values: they stay, so the viewer can still draw the dependency.
fn redact_literals(expr: &mut Value) {
    match expr {
        Value::Object(m) => {
            for (k, v) in m.iter_mut() {
                if k == "constant_value" {
                    *v = json!(REDACTED);
                } else {
                    redact_literals(v);
                }
            }
        }
        Value::Array(a) => a.iter_mut().for_each(redact_literals),
        _ => {}
    }
}

fn redact_module_values(module: &mut Value) {
    if let Some(resources) = module.get_mut("resources").and_then(Value::as_array_mut) {
        for r in resources {
            let mask = r.get("sensitive_values").cloned().unwrap_or(Value::Null);
            if let Some(v) = r.get_mut("values") {
                redact(v, &mask);
            }
        }
    }
    if let Some(children) = module.get_mut("child_modules").and_then(Value::as_array_mut) {
        for c in children {
            redact_module_values(c);
        }
    }
}

fn redact_state_values(values: Option<&mut Value>) {
    let Some(values) = values else { return };
    if let Some(root) = values.get_mut("root_module") {
        redact_module_values(root);
    }
    if let Some(outputs) = values.get_mut("outputs").and_then(Value::as_object_mut) {
        for o in outputs.values_mut() {
            if o.get("sensitive") == Some(&json!(true)) {
                o["value"] = json!(REDACTED);
            }
        }
    }
}

fn redact_config(
    module: &mut Value,
    prefix: &str,
    top_variables: &mut Option<&mut Map<String, Value>>,
    sens_keys: &HashMap<String, HashSet<String>>,
) {
    if let Some(vars) = module.get_mut("variables").and_then(Value::as_object_mut) {
        for (name, var) in vars.iter_mut() {
            if var.get("sensitive") != Some(&json!(true)) {
                continue;
            }
            if prefix.is_empty() {
                if let Some(v) = top_variables.as_mut().and_then(|t| t.get_mut(name)) {
                    v["value"] = json!(REDACTED);
                }
            }
            // a sensitive variable's default is a secret too
            if var.get("default").is_some() {
                var["default"] = json!(REDACTED);
            }
        }
    }
    if let Some(resources) = module.get_mut("resources").and_then(Value::as_array_mut) {
        for r in resources {
            let addr = r.get("address").and_then(Value::as_str).unwrap_or("");
            let Some(keys) = sens_keys.get(&normalize(&format!("{prefix}{addr}"))) else { continue };
            if let Some(exprs) = r.get_mut("expressions").and_then(Value::as_object_mut) {
                for (k, e) in exprs.iter_mut() {
                    if keys.contains("*") || keys.contains(k.as_str()) {
                        redact_literals(e);
                    }
                }
            }
        }
    }
    if let Some(calls) = module.get_mut("module_calls").and_then(Value::as_object_mut) {
        for (name, call) in calls.iter_mut() {
            if let Some(m) = call.get_mut("module") {
                redact_config(m, &format!("{prefix}module.{name}."), top_variables, sens_keys);
            }
        }
    }
}

/// Redacts `plan` in place.
pub fn redact_plan(plan: &mut Value) {
    // address (indexes stripped) -> names of the attributes that are sensitive
    let mut sens_keys: HashMap<String, HashSet<String>> = HashMap::new();

    if let Some(changes) = plan.get_mut("resource_changes").and_then(Value::as_array_mut) {
        for rc in changes {
            let addr = rc.get("address").and_then(Value::as_str).unwrap_or("").to_string();
            let Some(change) = rc.get_mut("change") else { continue };
            let mut keys = HashSet::new();
            for f in ["before_sensitive", "after_sensitive"] {
                match change.get(f) {
                    Some(Value::Bool(true)) => {
                        keys.insert("*".to_string());
                    }
                    Some(Value::Object(m)) => {
                        keys.extend(m.iter().filter(|(_, v)| has_secret(v)).map(|(k, _)| k.clone()));
                    }
                    _ => {}
                }
            }
            // instances of one resource (count, for_each) share one config block: keep every instance's keys
            if !keys.is_empty() {
                sens_keys.entry(normalize(&addr)).or_default().extend(keys);
            }
            redact_change(change);
        }
    }
    // drift entries carry the same before/after and masks as planned changes
    if let Some(drift) = plan.get_mut("resource_drift").and_then(Value::as_array_mut) {
        for rd in drift {
            if let Some(change) = rd.get_mut("change") {
                redact_change(change);
            }
        }
    }
    if let Some(outputs) = plan.get_mut("output_changes").and_then(Value::as_object_mut) {
        for oc in outputs.values_mut() {
            redact_change(oc);
        }
    }

    redact_state_values(plan.get_mut("planned_values"));
    redact_state_values(plan.get_mut("prior_state").and_then(|s| s.get_mut("values")));

    // the config and the top-level variables are separate fields of the plan: take both out of it
    let mut variables = plan.get_mut("variables").and_then(Value::as_object_mut).map(std::mem::take);
    if let Some(root) = plan.get_mut("configuration").and_then(|c| c.get_mut("root_module")) {
        redact_config(root, "", &mut variables.as_mut(), &sens_keys);
    }
    if let (Some(vars), Some(slot)) = (variables, plan.get_mut("variables")) {
        *slot = Value::Object(vars);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "hunter2-do-not-leak";
    const OLD: &str = "old-secret-do-not-leak";

    fn redacted(mut p: Value) -> Value {
        redact_plan(&mut p);
        p
    }

    /// The plan must not contain the text anywhere: any field, any depth, keys included.
    fn assert_absent(p: &Value, secrets: &[&str]) {
        let text = p.to_string();
        for s in secrets {
            assert!(!text.contains(s), "'{s}' leaked in: {text}");
        }
    }

    fn change(before: Value, after: Value, bs: Value, a_s: Value) -> Value {
        json!({ "before": before, "after": after, "before_sensitive": bs, "after_sensitive": a_s })
    }

    // ---- the whole plan -------------------------------------------------------------------------

    fn full_plan() -> Value {
        json!({
            "variables": { "db_password": { "value": SECRET }, "app": { "value": "web" } },
            "planned_values": {
                "outputs": { "pw": { "sensitive": true, "value": SECRET }, "url": { "sensitive": false, "value": "http://x" } },
                "root_module": { "resources": [{
                    "address": "aws_db_instance.main",
                    "values": { "password": SECRET, "name": "main" },
                    "sensitive_values": { "password": true }
                }]}
            },
            "prior_state": { "values": { "root_module": { "resources": [{
                "address": "aws_db_instance.main",
                "values": { "password": OLD }, "sensitive_values": { "password": true }
            }]}}},
            "resource_changes": [{
                "address": "aws_db_instance.main[0]",
                "change": change(json!({"password": OLD, "name": "main"}), json!({"password": SECRET, "name": "main"}),
                                 json!({"password": true}), json!({"password": true}))
            }],
            "resource_drift": [{
                "address": "aws_db_instance.main",
                "change": change(json!({"password": OLD}), json!({"password": SECRET}), json!({"password": true}), json!({"password": true}))
            }],
            "output_changes": { "pw": change(json!(OLD), json!(SECRET), json!(true), json!(true)) },
            "configuration": { "root_module": {
                "variables": { "db_password": { "sensitive": true, "default": SECRET }, "app": { "default": "web" } },
                "resources": [{
                    "address": "aws_db_instance.main",
                    "expressions": { "password": { "constant_value": SECRET }, "name": { "constant_value": "main" } }
                }]
            }}
        })
    }

    #[test]
    fn removes_every_copy_of_a_secret_from_a_full_plan() {
        // one secret, nine places it can sit: variable value and default, config literal, planned and
        // prior state, the change (before and after), drift, output change, output value
        assert_absent(&redacted(full_plan()), &[SECRET, OLD]);
    }

    #[test]
    fn keeps_shape_and_non_secret_values() {
        let p = redacted(full_plan());
        assert_eq!(p["resource_changes"][0]["change"]["after"]["password"], REDACTED);
        assert_eq!(p["resource_changes"][0]["change"]["after"]["name"], "main");
        assert_eq!(p["variables"]["app"]["value"], "web");
        assert_eq!(p["planned_values"]["outputs"]["url"]["value"], "http://x");
        assert_eq!(p["configuration"]["root_module"]["variables"]["app"]["default"], "web");
        assert_eq!(p["configuration"]["root_module"]["resources"][0]["expressions"]["name"]["constant_value"], "main");
    }

    #[test]
    fn a_plan_without_secrets_is_unchanged() {
        let p = json!({ "resource_changes": [{ "address": "a.b", "change": { "after": { "x": 1 } } }] });
        assert_eq!(redacted(p.clone()), p);
    }

    #[test]
    fn redacting_twice_equals_redacting_once() {
        let once = redacted(full_plan());
        assert_eq!(redacted(once.clone()), once);
    }

    #[test]
    fn unrelated_parts_are_not_touched() {
        // the viewer relies on these; redaction only replaces values, never removes or reorders fields
        let mut p = full_plan();
        p["format_version"] = json!("1.2");
        p["resource_changes"][0]["change"]["actions"] = json!(["update"]);
        p["resource_changes"][0]["change"]["after_unknown"] = json!({"id": true});
        let r = redacted(p);
        assert_eq!(r["format_version"], "1.2");
        assert_eq!(r["resource_changes"][0]["change"]["actions"], json!(["update"]));
        assert_eq!(r["resource_changes"][0]["change"]["after_unknown"], json!({"id": true}));
        assert_eq!(r["resource_changes"][0]["address"], "aws_db_instance.main[0]");
    }

    // ---- masks: how sensitive values are marked ------------------------------------------------

    #[test]
    fn mask_true_on_the_whole_value() {
        // a sensitive output, or a resource whose entire value is sensitive: the mask is `true`, not an object
        let r = redacted(json!({ "output_changes": { "o": change(json!(OLD), json!({"a": SECRET}), json!(true), json!(true)) } }));
        assert_eq!(r["output_changes"]["o"]["after"], REDACTED);
        assert_eq!(r["output_changes"]["o"]["before"], REDACTED);
    }

    #[test]
    fn sensitive_attribute_inside_a_nested_block_list() {
        // blocks are arrays of objects: the mask is an array of masks, and an empty `{}` means "nothing here"
        let after = json!({ "rule": [{ "port": 22, "token": SECRET }, { "port": 80, "token": OLD }] });
        let mask = json!({ "rule": [{ "token": true }, {}] });
        let r = redacted(json!({ "resource_changes": [{ "address": "a.b", "change": change(Value::Null, after, Value::Null, mask) }] }));
        let rule = &r["resource_changes"][0]["change"]["after"]["rule"];
        assert_eq!(rule[0]["token"], REDACTED);
        assert_eq!(rule[0]["port"], 22);
        assert_eq!(rule[1]["token"], OLD, "mask `{{}}` on the second element means it is not sensitive");
    }

    #[test]
    fn mask_false_and_empty_leave_values_alone() {
        let after = json!({ "a": SECRET, "b": SECRET });
        let r = redacted(json!({ "resource_changes": [{ "address": "a.b",
            "change": change(Value::Null, after.clone(), json!(false), json!({ "a": false, "b": {} })) }] }));
        assert_eq!(r["resource_changes"][0]["change"]["after"], after);
    }

    #[test]
    fn create_and_delete_have_a_null_side() {
        // create: before is null; delete: after is null and its mask is false. Neither may panic or invent values.
        let r = redacted(json!({ "resource_changes": [
            { "address": "a.new", "change": change(Value::Null, json!({"p": SECRET}), json!(false), json!({"p": true})) },
            { "address": "a.old", "change": change(json!({"p": OLD}), Value::Null, json!({"p": true}), json!(false)) },
        ]}));
        assert_eq!(r["resource_changes"][0]["change"]["before"], Value::Null);
        assert_eq!(r["resource_changes"][0]["change"]["after"]["p"], REDACTED);
        assert_eq!(r["resource_changes"][1]["change"]["before"]["p"], REDACTED);
        assert_eq!(r["resource_changes"][1]["change"]["after"], Value::Null);
    }

    #[test]
    fn attribute_unknown_until_apply_is_not_invented() {
        // a sensitive attribute whose value is not known yet is absent from `after` (it is in after_unknown):
        // redaction must not add a key that is not there
        let r = redacted(json!({ "resource_changes": [{ "address": "a.b",
            "change": change(Value::Null, json!({"name": "x"}), Value::Null, json!({"secret": true})) }] }));
        assert!(r["resource_changes"][0]["change"]["after"].get("secret").is_none());
    }

    #[test]
    fn mask_and_value_of_different_types_do_not_panic_or_leak_shape() {
        // not produced by Terraform, but a malformed or newer plan must not crash the Atlantis step
        let r = redacted(json!({ "resource_changes": [{ "address": "a.b", "change": change(
            Value::Null, json!({ "a": "text", "b": ["x"], "c": {"k": 1} }), Value::Null,
            json!({ "a": {"k": true}, "b": {"k": true}, "c": [true] })) }] }));
        assert_eq!(r["resource_changes"][0]["change"]["after"]["a"], "text");
    }

    #[test]
    fn mask_longer_than_the_value() {
        // a list shrank: the mask may have more entries than the value
        let r = redacted(json!({ "resource_changes": [{ "address": "a.b", "change":
            change(Value::Null, json!({ "l": [SECRET] }), Value::Null, json!({ "l": [true, true, true] })) }] }));
        assert_eq!(r["resource_changes"][0]["change"]["after"]["l"], json!([REDACTED]));
    }

    #[test]
    fn sensitive_only_before_or_only_after() {
        // an attribute can stop (or start) being sensitive in an update: each side follows its own mask
        let r = redacted(json!({ "resource_changes": [{ "address": "a.b", "change": change(
            json!({"p": OLD}), json!({"p": "public-now"}), json!({"p": true}), json!({"p": false})) }] }));
        assert_eq!(r["resource_changes"][0]["change"]["before"]["p"], REDACTED);
        assert_eq!(r["resource_changes"][0]["change"]["after"]["p"], "public-now");
    }

    // ---- state and outputs ---------------------------------------------------------------------

    #[test]
    fn secrets_in_child_modules_of_planned_and_prior_state() {
        let module = |v: &str| json!({ "resources": [], "child_modules": [{ "resources": [
            { "address": "module.m.aws_x.y", "values": {"p": v}, "sensitive_values": {"p": true} }],
            "child_modules": [{ "resources": [
            { "address": "module.m.module.n.aws_x.z", "values": {"p": v}, "sensitive_values": {"p": true} }] }] }] });
        let r = redacted(json!({ "planned_values": { "root_module": module(SECRET) },
                                 "prior_state": { "values": { "root_module": module(OLD) } } }));
        assert_absent(&r, &[SECRET, OLD]);
    }

    #[test]
    fn sensitive_output_in_prior_state() {
        let r = redacted(json!({ "prior_state": { "values": { "outputs": { "o": { "sensitive": true, "value": OLD } } } } }));
        assert_absent(&r, &[OLD]);
    }

    // ---- config: literals written in the .tf ---------------------------------------------------

    fn config_with_attr(attr: &str, expr: Value) -> Value {
        json!({ "configuration": { "root_module": { "resources": [{ "address": "aws_x.y", "expressions": { attr: expr } }] } } })
    }

    #[test]
    fn a_literal_in_config_is_removed_when_the_attribute_turned_out_sensitive() {
        // the .tf says password = "literal": Terraform marks the planned value sensitive, but the literal
        // is still in `configuration.expressions`
        let mut p = config_with_attr("password", json!({ "constant_value": SECRET }));
        p["resource_changes"] = json!([{ "address": "aws_x.y", "change": change(Value::Null, json!({"password": SECRET}), Value::Null, json!({"password": true})) }]);
        assert_absent(&redacted(p), &[SECRET]);
    }

    #[test]
    fn references_are_kept_so_the_viewer_still_draws_the_dependency() {
        // password = random_password.db.result: nothing secret in the expression, and the edge comes from it
        let mut p = config_with_attr("password", json!({ "references": ["random_password.db.result", "random_password.db"] }));
        p["resource_changes"] = json!([{ "address": "aws_x.y", "change": change(Value::Null, json!({"password": SECRET}), Value::Null, json!({"password": true})) }]);
        let r = redacted(p);
        assert_eq!(r["configuration"]["root_module"]["resources"][0]["expressions"]["password"]["references"][0], "random_password.db.result");
    }

    #[test]
    fn literals_inside_a_nested_block_expression_are_removed() {
        // a sensitive attribute that is a block: expressions are an array of objects of expressions
        let expr = json!([{ "token": { "constant_value": SECRET }, "port": { "constant_value": 22 } }]);
        let mut p = config_with_attr("auth", expr);
        p["resource_changes"] = json!([{ "address": "aws_x.y", "change": change(Value::Null, json!({"auth": [{"token": SECRET}]}), Value::Null, json!({"auth": [{"token": true}]})) }]);
        assert_absent(&redacted(p), &[SECRET]);
    }

    #[test]
    fn only_the_sensitive_attribute_loses_its_literal() {
        let mut p = json!({ "configuration": { "root_module": { "resources": [{ "address": "aws_x.y", "expressions": {
            "password": { "constant_value": SECRET }, "name": { "constant_value": "web" } } }] } },
            "resource_changes": [{ "address": "aws_x.y", "change": change(Value::Null, json!({}), Value::Null, json!({"password": true})) }] });
        let r = redacted(p.take());
        let e = &r["configuration"]["root_module"]["resources"][0]["expressions"];
        assert_eq!(e["password"]["constant_value"], REDACTED);
        assert_eq!(e["name"]["constant_value"], "web");
    }

    #[test]
    fn whole_resource_sensitive_redacts_every_literal() {
        let mut p = json!({ "configuration": { "root_module": { "resources": [{ "address": "aws_x.y", "expressions": {
            "a": { "constant_value": SECRET }, "b": { "constant_value": OLD } } }] } },
            "resource_changes": [{ "address": "aws_x.y", "change": change(Value::Null, json!({}), Value::Null, json!(true)) }] });
        assert_absent(&redacted(p.take()), &[SECRET, OLD]);
    }

    #[test]
    fn instances_of_one_resource_do_not_overwrite_each_others_keys() {
        // count = 2: [0] has a sensitive `a`, [1] a sensitive `b`; one config block serves both.
        // Keeping only the last instance's keys would leave the literal of `a` in the report.
        let p = json!({ "configuration": { "root_module": { "resources": [{ "address": "aws_x.y", "expressions": {
                "a": { "constant_value": SECRET }, "b": { "constant_value": OLD } } }] } },
            "resource_changes": [
                { "address": "aws_x.y[0]", "change": change(Value::Null, json!({}), Value::Null, json!({"a": true})) },
                { "address": "aws_x.y[1]", "change": change(Value::Null, json!({}), Value::Null, json!({"b": true})) } ] });
        assert_absent(&redacted(p), &[SECRET, OLD]);
    }

    #[test]
    fn for_each_keys_with_brackets_and_quotes() {
        // keys are free text: a `]` inside the quotes must not end the index early
        let p = json!({ "configuration": { "root_module": { "resources": [{ "address": "aws_x.y", "expressions": {
                "a": { "constant_value": SECRET } } }] } },
            "resource_changes": [{ "address": "aws_x.y[\"we]ird\\\"key\"]", "change": change(Value::Null, json!({}), Value::Null, json!({"a": true})) }] });
        assert_absent(&redacted(p), &[SECRET]);
    }

    #[test]
    fn config_of_a_module_resource_matches_its_instance_address() {
        // changes say `module.m["a"].aws_x.y[0]`, the config says `aws_x.y` inside module call `m`
        let p = json!({ "configuration": { "root_module": { "module_calls": { "m": { "module": { "resources": [
                { "address": "aws_x.y", "expressions": { "a": { "constant_value": SECRET } } }] } } } } },
            "resource_changes": [{ "address": "module.m[\"a\"].aws_x.y[0]", "change": change(Value::Null, json!({}), Value::Null, json!({"a": true})) }] });
        assert_absent(&redacted(p), &[SECRET]);
    }

    #[test]
    fn same_resource_name_in_another_module_is_not_confused() {
        // aws_x.y in the root is not sensitive; the one inside module m is. The root literal must stay.
        let p = json!({ "configuration": { "root_module": {
                "resources": [{ "address": "aws_x.y", "expressions": { "a": { "constant_value": "root-value" } } }],
                "module_calls": { "m": { "module": { "resources": [
                    { "address": "aws_x.y", "expressions": { "a": { "constant_value": SECRET } } }] } } } } },
            "resource_changes": [{ "address": "module.m.aws_x.y", "change": change(Value::Null, json!({}), Value::Null, json!({"a": true})) }] });
        let r = redacted(p);
        assert_absent(&r, &[SECRET]);
        assert_eq!(r["configuration"]["root_module"]["resources"][0]["expressions"]["a"]["constant_value"], "root-value");
    }

    // ---- variables -----------------------------------------------------------------------------

    #[test]
    fn sensitive_variable_value_and_default_in_the_root() {
        let r = redacted(json!({ "variables": { "pw": { "value": SECRET }, "n": { "value": 3 } },
            "configuration": { "root_module": { "variables": { "pw": { "sensitive": true, "default": SECRET }, "n": { "default": 3 } } } } }));
        assert_absent(&r, &[SECRET]);
        assert_eq!(r["variables"]["n"]["value"], 3);
        assert_eq!(r["configuration"]["root_module"]["variables"]["n"]["default"], 3);
    }

    #[test]
    fn sensitive_variable_without_a_default_gets_none_added() {
        let r = redacted(json!({ "configuration": { "root_module": { "variables": { "pw": { "sensitive": true } } } } }));
        assert!(r["configuration"]["root_module"]["variables"]["pw"].get("default").is_none());
    }

    #[test]
    fn sensitive_variable_with_a_null_default() {
        // `default = null` is a real default; it is redacted like any other (nothing to leak, nothing to crash)
        let r = redacted(json!({ "configuration": { "root_module": { "variables": { "pw": { "sensitive": true, "default": null } } } } }));
        assert_eq!(r["configuration"]["root_module"]["variables"]["pw"]["default"], REDACTED);
    }

    #[test]
    fn a_module_variable_does_not_redact_the_root_variable_of_the_same_name() {
        // module m has a sensitive `pw`; the root's own `pw` is not sensitive and keeps its value
        let r = redacted(json!({ "variables": { "pw": { "value": "root-ok" } },
            "configuration": { "root_module": { "variables": { "pw": {} },
                "module_calls": { "m": { "module": { "variables": { "pw": { "sensitive": true, "default": SECRET } } } } } } } }));
        assert_eq!(r["variables"]["pw"]["value"], "root-ok");
        assert_absent(&r, &[SECRET]);
    }

    // ---- input shapes --------------------------------------------------------------------------

    #[test]
    fn empty_and_partial_plans_do_not_panic() {
        for p in [json!({}), json!([]), json!(null), json!({ "resource_changes": [{}] }),
                  json!({ "resource_changes": [{ "address": "a.b" }] }), json!({ "planned_values": {} }),
                  json!({ "configuration": {} }), json!({ "output_changes": { "o": {} } }),
                  json!({ "prior_state": {} }), json!({ "variables": {} , "configuration": { "root_module": {} } })] {
            redacted(p);
        }
    }

    #[test]
    fn not_marked_sensitive_is_not_redacted() {
        // the known limit, kept visible: a secret Terraform does not mark sensitive (a plain string
        // variable, user_data, a tag) stays in the report. Marking it `sensitive = true` is the fix.
        let p = json!({ "resource_changes": [{ "address": "a.b", "change": change(Value::Null, json!({"user_data": "export TOKEN=abc"}), Value::Null, json!({})) }] });
        assert_eq!(redacted(p.clone()), p);
    }

    // ---- normalize -----------------------------------------------------------------------------

    #[test]
    fn normalize_strips_indexes() {
        assert_eq!(normalize("aws_x.y"), "aws_x.y");
        assert_eq!(normalize("aws_x.y[0]"), "aws_x.y");
        assert_eq!(normalize("module.m[\"a\"].aws_x.y[\"b\"]"), "module.m.aws_x.y");
        assert_eq!(normalize("module.a[0].module.b[1].aws_x.y[2]"), "module.a.module.b.aws_x.y");
        assert_eq!(normalize("aws_x.y[\"a]b\"]"), "aws_x.y");
        assert_eq!(normalize("aws_x.y[\"a[b\"].z"), "aws_x.y.z");
        assert_eq!(normalize("aws_x.y[\"q\\\"]\"]"), "aws_x.y");
    }
}
