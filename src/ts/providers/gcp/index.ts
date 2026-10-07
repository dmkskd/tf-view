// providers/gcp/index.ts — Google Cloud provider (starter: networks, subnetworks, instances, buckets)
import { ProviderPlugin, ProviderSettings, CatalogEntry, ProviderCommand, ProviderResource, asText } from "../../sdk/index.js";
import { startGcpPlacement } from "./placement.js";

export var GCP_REG: Record<string, CatalogEntry> = {
  google_compute_network:    {kind:"group", label:"VPC Network",    icon:"i-vpc",    cat:"net",
                              preview:["auto_create_subnetworks","routing_mode"]},
  google_compute_subnetwork: {kind:"group", label:"Subnetwork",     icon:"i-subnet", cat:"net",
                              preview:["ip_cidr_range","region","private_ip_google_access"]},
  google_compute_instance:   {kind:"node",              label:"Compute Engine", icon:"i-ec2",    cat:"compute", sub:"machine_type",
                              preview:["zone","machine_type"]},
  google_storage_bucket:     {kind:"node",              label:"Cloud Storage",  icon:"i-s3",     cat:"storage", scope:"region",
                              preview:["location","storage_class"]}
};

/* gcloud inspection commands. The resource's cloud name is its `name`
   attribute, not its Terraform label; the placeholder <name> is used when the
   plan does not contain it. */
export function gcpCommands(r: ProviderResource, settings: Readonly<ProviderSettings>): ProviderCommand[] {
  var L: ProviderCommand[] = [];
  function add(label: string, argv: string[]) { L.push({label:label, argv:argv}); }
  var name = asText(r.attrs.name) || "<name>";
  var project = settings.project ? ["--project", settings.project] : [];
  switch (r.type) {
    case "google_compute_instance": {
      var zone = asText(r.attrs.zone) || settings.zone;
      add("Describe", ["gcloud", "compute", "instances", "describe", name]
        .concat(zone ? ["--zone", String(zone)] : [], project));
      break;
    }
    case "google_compute_network":
      add("Describe", ["gcloud", "compute", "networks", "describe", name].concat(project));
      break;
    case "google_compute_subnetwork": {
      var region = asText(r.attrs.region) || settings.region;
      add("Describe", ["gcloud", "compute", "networks", "subnets", "describe", name]
        .concat(region ? ["--region", String(region)] : [], project));
      break;
    }
    case "google_storage_bucket":
      add("Describe", ["gcloud", "storage", "buckets", "describe", "gs://" + name].concat(project));
      break;
  }
  return L;
}

export const gcpProvider: ProviderPlugin = {
  id: "google",
  name: "Google Cloud",
  sourceAddresses: ["registry.terraform.io/hashicorp/google", "registry.terraform.io/hashicorp/google-beta",
            "registry.opentofu.org/hashicorp/google", "registry.opentofu.org/hashicorp/google-beta"],
  localNames: ["google", "google-beta"],
  typePrefix: "google_",
  cloudLabel: "Google Cloud",
  globalNote: "project-level",
  unplacedNote: "no network reference",
  settingKeys: ["project", "region", "zone"],
  cliName: "gcloud CLI",
  catalog: GCP_REG,
  categories: {
    compute: "var(--cat-compute)",
    net:     "var(--cat-net)",
    sec:     "var(--cat-sec)",
    storage: "var(--cat-storage)",
    db:      "var(--cat-db)",
    mgmt:    "var(--cat-mgmt)"
  },
  categoryLabels: [
    ["compute", "Compute Engine"],
    ["net",     "VPC Network"],
    ["storage", "Cloud Storage"]
  ],
  sizing: {
    blockHeight: () => 26
  },
  cli: gcpCommands,
  placement: { start: startGcpPlacement }
};

export default gcpProvider;
