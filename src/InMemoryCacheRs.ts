import { equal } from "@wry/equality";
import type {
  DocumentNode,
  FragmentDefinitionNode,
  InlineFragmentNode,
} from "graphql";
import type { OptimisticWrapperFunction } from "optimism";
import { wrap } from "optimism";

import type { OperationVariables } from "@apollo/client";
import type {
  DeepPartial,
  Reference,
  StoreObject,
} from "@apollo/client/utilities";
import {
  addTypenameToDocument,
  cacheSizes,
  canonicalStringify,
  DocumentTransform,
  isReference,
  print,
} from "@apollo/client/utilities";
import { __DEV__ } from "@apollo/client/utilities/environment";
import { getInMemoryCacheMemoryInternals } from "@apollo/client/utilities/internal";
import { invariant } from "@apollo/client/utilities/invariant";

import {
  ApolloCache,
  EntityStore,
  Policies,
  forgetCache,
  hasOwn,
  makeVar,
  recallCache,
  StoreReader,
  StoreWriter,
  supportsResultCaching,
} from "@apollo/client/cache";
import type {
  Cache,
  InMemoryCache,
  NormalizedCacheObject,
} from "@apollo/client/cache";

import type { InMemoryCacheRsConfig } from "./InMemoryCacheRsConfig.js";
import { normalizeInMemoryCacheRsConfig } from "./InMemoryCacheRsConfig.js";
import { convict_in_the_game } from "../pkg/fast_gql_cache_rs.js";

const DEFAULT_CACHE_SIZES = {
  "inMemoryCache.maybeBroadcastWatch": 5000,
} as const;

type BroadcastOptions = Pick<
  Cache.BatchOptions<InMemoryCacheRs>,
  "optimistic" | "onWatchUpdated"
>;

export class InMemoryCacheRs extends ApolloCache {
  private data!: EntityStore;
  private optimisticData!: EntityStore;

  protected config: InMemoryCacheRsConfig;
  private watches = new Set<Cache.WatchOptions<any, any>>();

  private storeReader!: StoreReader;
  private storeWriter!: StoreWriter;
  private addTypenameTransform = new DocumentTransform(addTypenameToDocument);

  private maybeBroadcastWatch!: OptimisticWrapperFunction<
    [Cache.WatchOptions<any, any>, BroadcastOptions?],
    any,
    [Cache.WatchOptions<any, any>]
  >;

  // Override the default value, since InMemoryCacheRs result objects are frozen
  // in development and expected to remain logically immutable in production.
  public readonly assumeImmutableResults = true;

  // Dynamically imported code can augment existing typePolicies or
  // possibleTypes by calling cache.policies.addTypePolicies or
  // cache.policies.addPossibletypes.
  public readonly policies: Policies;

  public readonly makeVar = makeVar;

  constructor(config: InMemoryCacheRsConfig = {}) {
    super();
    this.config = normalizeInMemoryCacheRsConfig(config);

    this.policies = new Policies({
      cache: this as unknown as InMemoryCache,
      dataIdFromObject: this.config.dataIdFromObject,
      possibleTypes: this.config.possibleTypes,
      typePolicies: this.config.typePolicies,
    });

    this.init();
  }

  private init() {
    convict_in_the_game();

    // Passing { resultCaching: false } in the InMemoryCacheRs constructor options
    // will completely disable dependency tracking, which will improve memory
    // usage but worsen the performance of repeated reads.
    const rootStore = (this.data = new EntityStore.Root({
      policies: this.policies,
      resultCaching: this.config.resultCaching,
    }));

    // When no optimistic writes are currently active, cache.optimisticData ===
    // cache.data, so there are no additional layers on top of the actual data.
    // When an optimistic update happens, this.optimisticData will become a
    // linked list of EntityStore Layer objects that terminates with the
    // original this.data cache object.
    this.optimisticData = rootStore.stump;

    this.resetResultCache();
  }

  private resetResultCache() {
    const { fragments } = this.config;

    this.addTypenameTransform.resetCache();
    fragments?.resetCaches();

    // The StoreWriter is mostly stateless and so doesn't really need to be
    // reset, but it does need to have its writer.storeReader reference updated,
    // so it's simpler to update this.storeWriter as well.
    this.storeWriter = new StoreWriter(
      this as unknown as InMemoryCache,
      (this.storeReader = new StoreReader({
        cache: this as unknown as InMemoryCache,
        fragments,
      })),
      fragments
    );

    this.maybeBroadcastWatch = wrap(
      (c: Cache.WatchOptions, options?: BroadcastOptions) => {
        return this.broadcastWatch(c, options);
      },
      {
        max:
          cacheSizes["inMemoryCache.maybeBroadcastWatch"] ||
          DEFAULT_CACHE_SIZES["inMemoryCache.maybeBroadcastWatch"],
        makeCacheKey: (c: Cache.WatchOptions) => {
          // Return a cache key (thus enabling result caching) only if we're
          // currently using a data store that can track cache dependencies.
          const store = c.optimistic ? this.optimisticData : this.data;
          if (supportsResultCaching(store)) {
            const { optimistic, id, variables } = c;
            return store.makeCacheKey(
              c.query,
              // Different watches can have the same query, optimistic
              // status, rootId, and variables, but if their callbacks are
              // different, the (identical) result needs to be delivered to
              // each distinct callback. The easiest way to achieve that
              // separation is to include c.callback in the cache key for
              // maybeBroadcastWatch calls. See issue #5733.
              c.callback,
              canonicalStringify({ optimistic, id, variables })
            );
          }
        },
      }
    );

    // Since we have thrown away all the cached functions that depend on the
    // CacheGroup dependencies maintained by EntityStore, we should also reset
    // all CacheGroup dependency information.
    new Set([this.data.group, this.optimisticData.group]).forEach((group) =>
      group.resetCaching()
    );
  }

  public restore(data: NormalizedCacheObject): this {
    this.init();
    // Since calling this.init() discards/replaces the entire StoreReader, along
    // with the result caches it maintains, this.data.replace(data) won't have
    // to bother deleting the old data.
    if (data) this.data.replace(data);
    return this;
  }

  public extract(optimistic: boolean = false): NormalizedCacheObject {
    return (optimistic ? this.optimisticData : this.data).extract();
  }

  public read<TData = unknown>(
    options: Cache.ReadOptions<TData, OperationVariables> & {
      returnPartialData: true;
    }
  ): TData | DeepPartial<TData> | null;

  public read<TData = unknown>(
    options: Cache.ReadOptions<TData, OperationVariables>
  ): TData | null;

  public read<TData = unknown>(
    options: Cache.ReadOptions<TData, OperationVariables>
  ): TData | DeepPartial<TData> | null {
    const { returnPartialData = false } = options;

    return this.storeReader.diffQueryAgainstStore<TData>({
      ...options,
      store: options.optimistic ? this.optimisticData : this.data,
      config: this.config,
      returnPartialData,
    }).result;
  }

  public write<
    TData = unknown,
    TVariables extends OperationVariables = OperationVariables,
  >(options: Cache.WriteOptions<TData, TVariables>): Reference | undefined {
    try {
      ++this.txCount;
      return this.storeWriter.writeToStore(this.data, options);
    } finally {
      if (!--this.txCount && options.broadcast !== false) {
        this.broadcastWatches();
      }
    }
  }

  public modify<Entity extends Record<string, any> = Record<string, any>>(
    options: Cache.ModifyOptions<Entity>
  ): boolean {
    if (hasOwn.call(options, "id") && !options.id) {
      return false;
    }
    const store = options.optimistic ? this.optimisticData : this.data;
    try {
      ++this.txCount;
      return store.modify(options.id || "ROOT_QUERY", options.fields, false);
    } finally {
      if (!--this.txCount && options.broadcast !== false) {
        this.broadcastWatches();
      }
    }
  }

  public diff<
    TData = unknown,
    TVariables extends OperationVariables = OperationVariables,
  >(options: Cache.DiffOptions<TData, TVariables>): Cache.DiffResult<TData> {
    return this.storeReader.diffQueryAgainstStore({
      ...options,
      store: options.optimistic ? this.optimisticData : this.data,
      rootId: options.id || "ROOT_QUERY",
      config: this.config,
    });
  }

  public watch<
    TData = unknown,
    TVariables extends OperationVariables = OperationVariables,
  >(watch: Cache.WatchOptions<TData, TVariables>): () => void {
    if (!this.watches.size) {
      recallCache(this);
    }
    this.watches.add(watch);
    if (watch.immediate) {
      this.maybeBroadcastWatch(watch);
    }
    return () => {
      if (this.watches.delete(watch) && !this.watches.size) {
        forgetCache(this);
      }
      this.maybeBroadcastWatch.forget(watch);
    };
  }

  public gc(options?: { resetResultCache?: boolean }) {
    canonicalStringify.reset();
    print.reset();
    const ids = this.optimisticData.gc();
    if (options && !this.txCount && options.resetResultCache) {
      this.resetResultCache();
    }
    return ids;
  }

  public retain(rootId: string, optimistic?: boolean): number {
    return (optimistic ? this.optimisticData : this.data).retain(rootId);
  }

  public release(rootId: string, optimistic?: boolean): number {
    return (optimistic ? this.optimisticData : this.data).release(rootId);
  }

  public identify(object: StoreObject | Reference): string | undefined {
    if (isReference(object)) return object.__ref;
    try {
      return this.policies.identify(object)[0];
    } catch (e) {
      invariant.warn(e);
    }
  }

  public evict(options: Cache.EvictOptions): boolean {
    if (!options.id) {
      if (hasOwn.call(options, "id")) {
        return false;
      }
      options = { ...options, id: "ROOT_QUERY" };
    }
    try {
      ++this.txCount;
      return this.optimisticData.evict(options, this.data);
    } finally {
      if (!--this.txCount && options.broadcast !== false) {
        this.broadcastWatches();
      }
    }
  }

  public reset(options?: Cache.ResetOptions): Promise<void> {
    this.init();

    canonicalStringify.reset();

    if (options && options.discardWatches) {
      this.watches.forEach((watch) => this.maybeBroadcastWatch.forget(watch));
      this.watches.clear();
      forgetCache(this);
    } else {
      this.broadcastWatches();
    }

    return Promise.resolve();
  }

  public removeOptimistic(idToRemove: string) {
    const newOptimisticData = this.optimisticData.removeLayer(idToRemove);
    if (newOptimisticData !== this.optimisticData) {
      this.optimisticData = newOptimisticData;
      this.broadcastWatches();
    }
  }

  private txCount = 0;

  public batch<TUpdateResult>(
    options: Cache.BatchOptions<InMemoryCacheRs, TUpdateResult>
  ): TUpdateResult {
    const {
      update,
      optimistic = true,
      removeOptimistic,
      onWatchUpdated,
    } = options;

    let updateResult: TUpdateResult;
    const perform = (layer?: EntityStore): TUpdateResult => {
      const { data, optimisticData } = this;
      ++this.txCount;
      if (layer) {
        this.data = this.optimisticData = layer;
      }
      try {
        return (updateResult = update(this));
      } finally {
        --this.txCount;
        this.data = data;
        this.optimisticData = optimisticData;
      }
    };

    const alreadyDirty = new Set<Cache.WatchOptions>();

    if (onWatchUpdated && !this.txCount) {
      this.broadcastWatches({
        ...options,
        onWatchUpdated(watch) {
          alreadyDirty.add(watch);
          return false;
        },
      });
    }

    if (typeof optimistic === "string") {
      this.optimisticData = this.optimisticData.addLayer(optimistic, perform);
    } else if (optimistic === false) {
      perform(this.data);
    } else {
      perform();
    }

    if (typeof removeOptimistic === "string") {
      this.optimisticData = this.optimisticData.removeLayer(removeOptimistic);
    }

    if (onWatchUpdated && alreadyDirty.size) {
      this.broadcastWatches({
        ...options,
        onWatchUpdated(watch, diff) {
          const result = onWatchUpdated.call(this, watch, diff);
          if (result !== false) {
            alreadyDirty.delete(watch);
          }
          return result;
        },
      });
      if (alreadyDirty.size) {
        alreadyDirty.forEach((watch) => this.maybeBroadcastWatch.dirty(watch));
      }
    } else {
      this.broadcastWatches(options);
    }

    return updateResult!;
  }

  public performTransaction(
    update: (cache: InMemoryCacheRs) => any,
    optimisticId?: string | null
  ) {
    return this.batch({
      update,
      optimistic: optimisticId || optimisticId !== null,
    });
  }

  public transformDocument(document: DocumentNode): DocumentNode {
    return this.addTypenameTransform.transformDocument(
      this.addFragmentsToDocument(document)
    );
  }

  public fragmentMatches(
    fragment: InlineFragmentNode | FragmentDefinitionNode,
    typename: string
  ): boolean {
    return this.policies.fragmentMatches(fragment, typename);
  }

  public lookupFragment(fragmentName: string): FragmentDefinitionNode | null {
    return this.config.fragments?.lookup(fragmentName) || null;
  }

  public resolvesClientField(typename: string, fieldName: string): boolean {
    return !!this.policies.getReadFunction(typename, fieldName);
  }

  protected broadcastWatches(options?: BroadcastOptions) {
    if (!this.txCount) {
      const prevOnAfter = this.onAfterBroadcast;
      const callbacks = new Set<() => void>();
      this.onAfterBroadcast = (cb: () => void) => {
        callbacks.add(cb);
      };
      try {
        this.watches.forEach((c) => this.maybeBroadcastWatch(c, options));
        callbacks.forEach((cb) => cb());
      } finally {
        this.onAfterBroadcast = prevOnAfter;
      }
    }
  }

  private addFragmentsToDocument(document: DocumentNode) {
    const { fragments } = this.config;
    return fragments ? fragments.transform(document) : document;
  }

  private broadcastWatch(c: Cache.WatchOptions, options?: BroadcastOptions) {
    const { lastDiff } = c;
    const diff = this.diff<any>(c);

    if (options) {
      if (c.optimistic && typeof options.optimistic === "string") {
        diff.fromOptimisticTransaction = true;
      }

      if (
        options.onWatchUpdated &&
        options.onWatchUpdated.call(this, c, diff, lastDiff) === false
      ) {
        return;
      }
    }

    if (!lastDiff || !equal(lastDiff.result, diff.result)) {
      c.callback((c.lastDiff = diff), lastDiff);
    }
  }

  public declare getMemoryInternals?: typeof getInMemoryCacheMemoryInternals;
}

if (__DEV__) {
  InMemoryCacheRs.prototype.getMemoryInternals = getInMemoryCacheMemoryInternals;
}
