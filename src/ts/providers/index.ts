// providers/index.ts — registers the providers included in this build
//
// To add a provider, create providers/<name>/ (its files may import only
// ../../sdk/index.js and each other) and add the plugin to this list. No
// change outside the provider's folder and this list is required.
import { registerProviders } from "../core/registry.js";
import { awsProvider } from "./aws/index.js";
import { gcpProvider } from "./gcp/index.js";

registerProviders([awsProvider, gcpProvider]);
