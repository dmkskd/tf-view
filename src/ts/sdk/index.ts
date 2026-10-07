// sdk/index.ts — the provider SDK: the only module a provider may import
//
// Files under providers/<name>/ may import from this module and from files in
// their own folder; tools/check-providers.js fails the build otherwise. Every
// provider depends on each export here, so additions need maintainer review.
export type {
  ProviderPlugin, ProviderSettings, ConsoleHost, IconDefinition, CatalogEntry, ProviderResource, JsonValue, JsonObject, ProviderCommand,
  ProviderRules, RuleDescription, RuleListSpec, RuleListDirection, ProviderSizing,
  ProviderPlacement, PlacementApi, PlacementSession, ContainerRef, ContainerSpec
} from "../types/index.js";
export { asText, valueAt, asList } from "./values.js";
export { referencedValues, singleReferencedValue } from "./refs.js";
