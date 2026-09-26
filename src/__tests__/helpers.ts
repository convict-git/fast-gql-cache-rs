// Adapted from apollo-client-sm/src/cache/inmemory/__tests__/helpers.ts. Two changes:
// the helpers build their store and collaborators for InMemoryCacheRs, and this module
// also exports StoreReader/StoreWriter subclasses that accept an InMemoryCacheRs, so
// the adapted suites keep Apollo's test bodies unchanged. When Rust-WASM replaces
// EntityStore, defaultNormalizedCacheFactory and writeQueryToStore are the one place
// that points these suites at the new store.
import type { Cache } from "@apollo/client";
import type {
  DiffQueryAgainstStoreOptions,
  InMemoryCache,
  NormalizedCache,
  NormalizedCacheObject,
} from "@apollo/client/cache";
import {
  EntityStore,
  StoreReader as ApolloStoreReader,
  StoreWriter as ApolloStoreWriter,
} from "@apollo/client/cache";

import { InMemoryCacheRs } from "../InMemoryCacheRs.js";

type StoreReaderConfig = ConstructorParameters<typeof ApolloStoreReader>[0];
type StoreWriterFragments = ConstructorParameters<typeof ApolloStoreWriter>[2];

// Apollo's StoreReader, constructed for an InMemoryCacheRs.
export class StoreReader extends ApolloStoreReader {
  constructor(
    config: Omit<StoreReaderConfig, "cache"> & { cache: InMemoryCacheRs }
  ) {
    super({ ...config, cache: config.cache as unknown as InMemoryCache });
  }
}

// Apollo's StoreWriter, constructed for an InMemoryCacheRs.
export class StoreWriter extends ApolloStoreWriter {
  constructor(
    cache: InMemoryCacheRs,
    reader?: ApolloStoreReader,
    fragments?: StoreWriterFragments
  ) {
    super(cache as unknown as InMemoryCache, reader, fragments);
  }
}

export function defaultNormalizedCacheFactory(
  seed?: NormalizedCacheObject
): NormalizedCache {
  const cache = new InMemoryCacheRs();
  return new EntityStore.Root({
    policies: cache.policies,
    resultCaching: true,
    seed,
  });
}

interface WriteQueryToStoreOptions extends Cache.WriteOptions {
  writer: ApolloStoreWriter;
  store?: NormalizedCache;
}

export function readQueryFromStore<T = any>(
  reader: ApolloStoreReader,
  options: DiffQueryAgainstStoreOptions
) {
  return reader.diffQueryAgainstStore<T>({
    ...options,
    returnPartialData: false,
  }).result;
}

export function writeQueryToStore(
  options: WriteQueryToStoreOptions
): NormalizedCache {
  const {
    dataId = "ROOT_QUERY",
    store = new EntityStore.Root({
      policies: options.writer.cache.policies,
    }),
    ...writeOptions
  } = options;
  options.writer.writeToStore(store, {
    ...writeOptions,
    dataId,
  });
  return store;
}

export function withError(func: Function, regex?: RegExp) {
  let message: string = null as never;
  const { error } = console;
  console.error = (m: any) => {
    message = m;
  };

  try {
    const result = func();
    if (regex) {
      expect(message).toMatch(regex);
    }
    return result;
  } finally {
    console.error = error;
  }
}

describe("defaultNormalizedCacheFactory", function () {
  it("should return an EntityStore", function () {
    const store = defaultNormalizedCacheFactory();
    expect(store).toBeInstanceOf(EntityStore);
    expect(store).toBeInstanceOf(EntityStore.Root);
  });
});
