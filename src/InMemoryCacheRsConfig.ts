import type {
  ApolloReducerConfig,
  FragmentRegistryAPI,
  PossibleTypesMap,
  TypePolicies,
} from "@apollo/client/cache";
import { defaultDataIdFromObject } from "@apollo/client/cache";
import { compact } from "@apollo/client/utilities/internal";

/**
 * Configuration for {@link InMemoryCacheRs}.
 *
 * Standalone cache configuration — not an extension of Apollo's
 * `InMemoryCacheConfig`. Field shapes mirror Apollo's cache options today so
 * existing type policies, `possibleTypes`, and fragment setup remain
 * plug-and-play during Phase 1. WASM-specific options will be added here as
 * the Rust core replaces delegated Apollo collaborators.
 */
export interface InMemoryCacheRsConfig {
  dataIdFromObject?: ApolloReducerConfig["dataIdFromObject"];
  resultCaching?: boolean;
  possibleTypes?: PossibleTypesMap;
  typePolicies?: TypePolicies;
  fragments?: FragmentRegistryAPI;
}

const defaultConfig: InMemoryCacheRsConfig = {
  dataIdFromObject: defaultDataIdFromObject,
  resultCaching: true,
};

export function normalizeInMemoryCacheRsConfig(
  config: InMemoryCacheRsConfig = {}
): InMemoryCacheRsConfig {
  return compact(defaultConfig, config);
}
