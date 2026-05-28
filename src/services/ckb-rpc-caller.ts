/* eslint-disable @typescript-eslint/no-explicit-any */
import pLimit from 'p-limit';
import { Indexer, RPC } from '@ckb-lumos/lumos';
import { env } from '../env';

type BatchRequestItem = [method: string, ...params: any[]];

interface LumosBatchRequest {
  add: (method: string, ...params: any[]) => LumosBatchRequest;
  exec: () => Promise<any[]>;
}

export interface CkbBatchRequestBuilder {
  add: (method: string, ...params: any[]) => CkbBatchRequestBuilder;
}

/**
 * Global concurrency + timeout coordinator for all CKB JSON-RPC traffic.
 *
 * - RPC: limiter is injected via the custom `fetch` passed to `new CKBRPC(url, { fetch, timeout })`,
 *   so every method call AND every `createBatchRequest().exec()` automatically holds one slot.
 * - Indexer: lumos's `CkbIndexer` does not accept a fetch hook, so a Proxy wraps its public
 *   methods (`tip` / `getCells` / `getTransactions`) and routes each through the same limiter.
 *   `collector()` and other members are passed through unwrapped — see `wrapIndexer` for why
 *   that still keeps collector pagination inside the limiter (it depends on a `this`-binding
 *   invariant — do NOT change without reading that comment).
 * - Batch: `batch()` auto-splits a builder over `CKB_RPC_BATCH_MAX_SIZE` to keep any one
 *   HTTP request from monopolizing the node; each chunk holds one slot independently.
 */
export class CkbRpcCaller {
  private readonly limit: pLimit.Limit;
  private readonly batchMaxSize: number;
  public readonly rpc: RPC;
  public readonly indexer: Indexer;

  constructor(url: string) {
    this.limit = pLimit(env.CKB_RPC_MAX_CONCURRENCY);
    this.batchMaxSize = env.CKB_RPC_BATCH_MAX_SIZE;

    const limitedFetch = ((input: any, init?: any) => this.limit(() => fetch(input, init))) as typeof fetch;

    this.rpc = new RPC(url, {
      timeout: env.CKB_HTTP_TIMEOUT_MS,
      fetch: limitedFetch,
    });

    this.indexer = this.wrapIndexer(new Indexer(url));
  }

  /**
   * Execute a batch RPC, auto-splitting into chunks of at most `CKB_RPC_BATCH_MAX_SIZE`
   * sub-requests. Each chunk holds one concurrency slot, so chunks can run in parallel
   * but a single mega-batch can never monopolize the node.
   */
  public async batch<R = any>(build: (b: CkbBatchRequestBuilder) => void): Promise<R[]> {
    const items: BatchRequestItem[] = [];
    const builder: CkbBatchRequestBuilder = {
      add: (method, ...params) => {
        items.push([method, ...params]);
        return builder;
      },
    };
    build(builder);

    if (items.length === 0) {
      return [];
    }

    if (items.length <= this.batchMaxSize) {
      return this.execChunk<R>(items);
    }

    const chunks: BatchRequestItem[][] = [];
    for (let i = 0; i < items.length; i += this.batchMaxSize) {
      chunks.push(items.slice(i, i + this.batchMaxSize));
    }
    const results = await Promise.all(chunks.map((chunk) => this.execChunk<R>(chunk)));
    return results.flat();
  }

  private async execChunk<R>(items: BatchRequestItem[]): Promise<R[]> {
    // RPC.createBatchRequest goes through the limited fetch above, so we do not
    // wrap exec() again here — that would double-count the slot.
    const batch = this.rpc.createBatchRequest(items) as unknown as LumosBatchRequest;
    return batch.exec() as Promise<R[]>;
  }

  /**
   * Wrap the indexer so that `tip` / `getCells` / `getTransactions` go through the limiter.
   *
   * INVARIANT — pass-through methods must be returned UNBOUND (no `.bind`/`.apply`/wrapper).
   * --------------------------------------------------------------------------------------
   * The single most important call site is `collector()`. Lumos implements it as:
   *
   *     collector(q, opts) { return new CKBCellCollector(this, q, opts); }
   *
   * and the collector then paginates via `this.terminableCellFetcher.getCells(...)`
   * (collector.js:127). Because we return the raw method here without binding, JS sets
   * `this = receiver = proxy` when `proxy.collector(q)` is invoked — so the collector
   * captures the PROXY as its fetcher, and every internal `getCells` page goes back
   * through the Proxy → through the limiter.
   *
   * If a future change "tidies" the pass-through branch to `value.bind(target)` or
   * `(...args) => value.apply(target, args)`, the collector will capture the unwrapped
   * indexer and silently bypass the limiter. Don't do that.
   *
   * For limited methods we DO use `apply(target, args)` — that's safe because the outer
   * `this.limit(...)` already holds the slot for the whole call duration, and inner
   * `this` binding doesn't affect correctness.
   *
   * Methods left unlimited and unused by this project: `subscribe`, `subscribeMedianTime`,
   * `waitForSync`, `start`/`stop`/`startForever`. If any of these become used, decide
   * explicitly whether to add them to `limitedMethods`.
   */
  private wrapIndexer(indexer: Indexer): Indexer {
    const limitedMethods = new Set(['tip', 'getCells', 'getTransactions']);
    return new Proxy(indexer, {
      get: (target, prop, receiver) => {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function' || typeof prop !== 'string' || !limitedMethods.has(prop)) {
          // Must stay unbound — see INVARIANT above.
          return value;
        }
        return (...args: unknown[]) => this.limit(() => (value as (...a: unknown[]) => unknown).apply(target, args));
      },
    });
  }
}
