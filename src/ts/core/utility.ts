// core/utility.ts — Terraform utility resources
//
// Resources from Terraform's utility providers (time_sleep, random_password,
// null_resource, terraform_data, ...) create nothing in a cloud. The diagram
// hides them by default and, when shown, draws them in a box of their own
// outside the cloud boxes.

/* Provider source addresses, lower case, without the registry host. */
var UTILITY_SOURCES = [
  "hashicorp/time", "hashicorp/random", "hashicorp/null", "hashicorp/tls",
  "hashicorp/local", "hashicorp/external", "hashicorp/http", "hashicorp/archive",
  "hashicorp/cloudinit", "builtin/terraform"
];

var UTILITY_HOSTS = ["registry.terraform.io/", "registry.opentofu.org/", "terraform.io/"];

/* Type prefixes, for input without provider_name (a state file, a
   hand-written plan). */
var UTILITY_PREFIXES = ["time_", "random_", "null_", "tls_", "local_"];

export function isUtilityProviderName(providerName: string | null | undefined): boolean {
  if (!providerName) return false;
  var s = String(providerName).toLowerCase();
  for (var i = 0; i < UTILITY_HOSTS.length; i++){
    if (s.indexOf(UTILITY_HOSTS[i]) === 0){ s = s.slice(UTILITY_HOSTS[i].length); break; }
  }
  return UTILITY_SOURCES.indexOf(s) >= 0;
}

export function isUtilityType(type: string): boolean {
  return type === "terraform_data" ||
         UTILITY_PREFIXES.some(function(p: string){ return type.indexOf(p) === 0; });
}
