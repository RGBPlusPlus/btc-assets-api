import axios, { AxiosInstance, isAxiosError } from 'axios';
import pLimit from 'p-limit';
import { z } from 'zod';
import { IBitcoinDataProvider } from './interface';
import { Transaction, UTXO } from './schema';

// Bitcoin MAX_MONEY is below Number.MAX_SAFE_INTEGER, so every valid satoshi amount is exact.
const Satoshi = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(
    z
      .number()
      .int()
      .min(0)
      .max(21_000_000 * 10 ** 8),
  );
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const MAX_UINT32 = 0xffffffff;
const Uint32 = z.number().int().min(0).max(MAX_UINT32);
const CHAIN_PAGE_SIZE = 25;
const MEMPOOL_PAGE_SIZE = 50;
const MEMPOOL_SCAN_PAGE_SIZE = 1_000;
const MAX_MEMPOOL_SCAN_PAGES = 100;
const IN_BLOCK_PAGE_SIZE = 1_000;
const MAX_IN_BLOCK_PAGES = 20;
const BlockbookTx = z.object({
  txid: Hash,
  confirmations: Uint32,
  blockHeight: z.number().int().min(-1).max(MAX_UINT32).optional(),
  blockHash: Hash.optional(),
  blockTime: Uint32.optional(),
});
const BlockbookAddressPage = z.object({
  page: z.number().int().positive(),
  totalPages: z.number().int().min(-1),
  itemsOnPage: z.number().int().positive(),
  unconfirmedTxs: Uint32,
  txs: Uint32,
  // Blockbook's Go API omits an empty txids array.
  txids: z.array(Hash).default([]),
});
const BlockbookUtxos = z.array(
  z
    .object({
      txid: Hash,
      vout: z.number().int().min(0).max(0xffffffff),
      value: Satoshi,
      confirmations: z.number().int().min(0).max(0xffffffff),
      height: z.number().int().min(0).max(0xffffffff).optional(),
    })
    .refine(({ confirmations, height }) => (confirmations > 0 ? (height ?? 0) > 0 : !height), {
      path: ['height'],
      message: 'UTXO height must agree with confirmations',
    }),
);

type AddressTxids = { pending: string[]; confirmed: string[] };

export class BlockbookInputError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400,
  ) {
    super(message);
    this.name = 'BlockbookInputError';
  }
}

export class BlockbookHistoryLimitError extends Error {
  public readonly statusCode = 503;

  constructor() {
    super('Blockbook cannot return the full pending address history within its pagination limit');
    this.name = 'BlockbookHistoryLimitError';
  }
}

function inputTxid(txid: string) {
  const hash = Hash.safeParse(txid.toLowerCase());
  if (!hash.success) {
    throw new BlockbookInputError('Invalid Bitcoin transaction id', 400);
  }
  return hash.data;
}

function asStatus(tx: z.infer<typeof BlockbookTx>): UTXO['status'] {
  if (tx.confirmations === 0) {
    return { confirmed: false };
  }
  if (tx.blockHeight === undefined || tx.blockHeight < 0 || !tx.blockHash || !tx.blockTime) {
    throw new Error('Blockbook confirmed transaction is missing valid block metadata');
  }
  return { confirmed: true, block_height: tx.blockHeight, block_hash: tx.blockHash, block_time: tx.blockTime };
}

export class BlockbookClient implements Pick<IBitcoinDataProvider, 'getAddressTxsUtxo'> {
  private request: AxiosInstance;
  private hydrateLimit = pLimit(8);

  constructor(baseURL: string, timeout = 10_000) {
    this.request = axios.create({ baseURL, timeout });
  }

  public async getGenesisHash(): Promise<string> {
    const { data } = await this.request.get<unknown>('/api/v2/block-index/0');
    return z.object({ blockHash: Hash }).parse(data).blockHash;
  }

  public async checkReady(): Promise<void> {
    const { data } = await this.request.get<unknown>('/api/');
    const { blockbook } = z
      .object({
        blockbook: z.object({ inSync: z.boolean(), inSyncMempool: z.boolean() }),
      })
      .parse(data);
    if (!blockbook.inSync || !blockbook.inSyncMempool) {
      throw new Error('Blockbook has not synced the Bitcoin chain and mempool');
    }
  }

  public async getAddressTxsUtxo({ address }: { address: string }): Promise<UTXO[]> {
    // confirmed=false includes mempool outputs and excludes confirmed outputs spent in the mempool.
    const { data } = await this.request.get<unknown>('/api/v2/utxo/' + encodeURIComponent(address), {
      params: { confirmed: false },
    });
    return BlockbookUtxos.parse(data).map(({ txid, vout, value, confirmations, height }) => ({
      txid,
      vout,
      value,
      status: confirmations > 0 ? { confirmed: true, block_height: height } : { confirmed: false },
    }));
  }

  private async readTransaction(txid: string, signal?: AbortSignal): Promise<unknown> {
    try {
      const { data } = await this.request.get<unknown>('/api/v2/tx/' + txid, { signal });
      return data;
    } catch (error) {
      // Blockbook v0.4 emits a public API error with HTTP 400 for this case.
      // A generic 400/404 or a backend error is not evidence of a missing tx.
      if (
        isAxiosError<{ error?: unknown }>(error) &&
        (error.response?.status === 400 || error.response?.status === 404) &&
        error.response.data?.error === `Transaction '${txid}' not found`
      ) {
        return undefined;
      }
      throw error;
    }
  }

  public async getTransactionStatus(txid: string, signal?: AbortSignal): Promise<UTXO['status'] | undefined> {
    txid = inputTxid(txid);
    const data = await this.readTransaction(txid, signal);
    if (data === undefined) {
      return undefined;
    }
    const transaction = BlockbookTx.parse(data);
    if (transaction.txid !== txid) {
      throw new Error('Blockbook returned the wrong transaction');
    }
    return asStatus(transaction);
  }

  private async readAddressPage(
    address: string,
    page: number,
    pageSize: number,
    signal: AbortSignal,
    bounds?: { to: number; from?: number },
  ) {
    const { data } = await this.request.get<unknown>('/api/v2/address/' + encodeURIComponent(address), {
      params: { details: 'txids', page, pageSize, ...bounds },
      signal,
    });
    const result = BlockbookAddressPage.parse(data);
    if (
      result.itemsOnPage !== pageSize ||
      result.page > page ||
      (result.page < page && result.totalPages !== -1 && result.page !== result.totalPages) ||
      (bounds && (result.unconfirmedTxs !== 0 || result.txids.length > pageSize))
    ) {
      throw new Error('Blockbook returned inconsistent address history pagination');
    }
    return result;
  }

  private async getAddressTxids(
    { address, after_txid }: { address: string; after_txid?: string },
    signal: AbortSignal,
  ): Promise<AddressTxids> {
    if (!after_txid) {
      const first = await this.readAddressPage(address, 1, CHAIN_PAGE_SIZE + MEMPOOL_PAGE_SIZE, signal);
      const pending = first.txids.slice(0, Math.min(first.unconfirmedTxs, MEMPOOL_PAGE_SIZE));
      if (pending.length !== Math.min(first.unconfirmedTxs, MEMPOOL_PAGE_SIZE)) {
        throw new Error('Blockbook address history changed while reading the first page; retry');
      }
      return { pending, confirmed: await this.getFirstConfirmedTxids(address, first, pending, signal) };
    }

    const cursor = inputTxid(after_txid);
    const status = await this.getTransactionStatus(cursor, signal);
    if (!status) {
      throw new BlockbookInputError('after_txid must identify a Bitcoin address transaction', 400);
    }
    if (!status.confirmed) {
      return this.getAddressTxidsAfterPending(address, cursor, signal);
    }
    if (status.block_height === undefined || status.block_height < 1) {
      throw new BlockbookInputError('after_txid must identify a confirmed address transaction', 400);
    }

    // First search only the cursor's block. An exclusive height bound would drop later
    // same-block txids, and walking from the tip would make old/hot cursors expensive.
    const height = status.block_height;
    const seen = new Set<string>();
    const result: string[] = [];
    let previousPage: string[] = [];
    let found = false;
    let exhausted = false;
    for (let page = 1; page <= MAX_IN_BLOCK_PAGES; page++) {
      const inBlock = await this.readAddressPage(address, page, IN_BLOCK_PAGE_SIZE, signal, {
        from: height,
        to: height,
      });
      // v0.4's filtered pages return totalPages=-1 while the total is unknown. When the
      // final page is full, requesting the next page can return the previous (clamped) page.
      if (inBlock.page < page) {
        if (
          inBlock.page !== page - 1 ||
          inBlock.txids.length !== previousPage.length ||
          inBlock.txids.some((txid, index) => txid !== previousPage[index])
        ) {
          throw new Error('Blockbook address history changed while reading a cursor; retry');
        }
        exhausted = true;
        break;
      }
      for (const txid of inBlock.txids) {
        if (seen.has(txid)) {
          throw new Error('Blockbook returned duplicate address history while reading a cursor; retry');
        }
        seen.add(txid);
        if (found && result.length < CHAIN_PAGE_SIZE) {
          result.push(txid);
        }
        if (txid === cursor) {
          found = true;
        }
      }
      exhausted =
        inBlock.txids.length < IN_BLOCK_PAGE_SIZE || (inBlock.totalPages !== -1 && inBlock.totalPages <= page);
      if (exhausted || result.length === CHAIN_PAGE_SIZE) {
        break;
      }
      previousPage = inBlock.txids;
    }

    // Use the index's block, not the upstream Bitcoin node's tip, to detect a reorg
    // that invalidated the cursor while we were traversing the indexed address rows.
    if (!exhausted && result.length < CHAIN_PAGE_SIZE) {
      throw new Error('Blockbook address history exceeded the in-block scan limit');
    }
    if (found && result.length < CHAIN_PAGE_SIZE && height > 1) {
      const older = await this.readAddressPage(address, 1, CHAIN_PAGE_SIZE - result.length, signal, { to: height - 1 });
      for (const txid of older.txids) {
        if (seen.has(txid)) {
          throw new Error('Blockbook address history changed while reading a cursor; retry');
        }
        seen.add(txid);
        result.push(txid);
      }
    }
    const { data } = await this.request.get<unknown>(`/api/v2/block-index/${height}`, { signal });
    if (z.object({ blockHash: Hash }).parse(data).blockHash !== status.block_hash) {
      throw new Error('Blockbook cursor block changed during address history lookup; retry');
    }
    if (!found) {
      throw new BlockbookInputError('after_txid does not belong to this Bitcoin address history', 400);
    }
    return { pending: [], confirmed: result };
  }

  private async getFirstConfirmedTxids(
    address: string,
    first: z.infer<typeof BlockbookAddressPage>,
    pending: string[],
    signal: AbortSignal,
  ): Promise<string[]> {
    let confirmed = first.txids.slice(first.unconfirmedTxs, first.unconfirmedTxs + CHAIN_PAGE_SIZE);
    // Some Blockbook releases page one combined sequence; older releases prepend all mempool
    // txids to the first confirmed page. If pending ids filled the window, read chain only.
    if (confirmed.length < Math.min(first.txs, CHAIN_PAGE_SIZE)) {
      const chain = await this.readAddressPage(address, 1, CHAIN_PAGE_SIZE, signal, { to: MAX_UINT32 });
      confirmed = chain.txids;
    }

    if (
      confirmed.length !== Math.min(first.txs, CHAIN_PAGE_SIZE) ||
      new Set([...pending, ...confirmed]).size !== pending.length + confirmed.length
    ) {
      throw new Error('Blockbook address history changed while reading the first page; retry');
    }
    return confirmed;
  }

  private async getAddressTxidsAfterPending(
    address: string,
    cursor: string,
    signal: AbortSignal,
  ): Promise<AddressTxids> {
    let pageSize = CHAIN_PAGE_SIZE + MEMPOOL_PAGE_SIZE;
    let first = await this.readAddressPage(address, 1, pageSize, signal);
    const prefix = first.txids.slice(0, first.unconfirmedTxs);
    const index = prefix.indexOf(cursor);
    if (prefix.length < first.unconfirmedTxs && (index === -1 || prefix.length - index - 1 < MEMPOOL_PAGE_SIZE)) {
      pageSize = MEMPOOL_SCAN_PAGE_SIZE;
      const expanded = await this.readAddressPage(address, 1, pageSize, signal);
      if (expanded.unconfirmedTxs !== first.unconfirmedTxs || prefix.some((txid, i) => txid !== expanded.txids[i])) {
        throw new Error('Blockbook address history changed while reading a mempool cursor; retry');
      }
      first = expanded;
    }

    const count = first.unconfirmedTxs;
    // v0.6 prepends mempool txids only on page one, truncates that page, and reports
    // the confirmed page count. In the combined layout, a full pending page adds
    // at least one to that count; v0.4 returns the whole pending prefix on page one.
    const hasTruncatedPrefix =
      count > pageSize &&
      first.txids.length === pageSize &&
      first.totalPages === Math.max(1, Math.ceil(first.txs / pageSize));
    const available = hasTruncatedPrefix ? pageSize : Math.min(count, pageSize * MAX_MEMPOOL_SCAN_PAGES);
    const pending: string[] = [];
    const seen = new Set<string>();
    let found = false;
    for (let page = 1; (page - 1) * pageSize < available; page++) {
      const current = page === 1 ? first : await this.readAddressPage(address, page, pageSize, signal);
      const remaining = available - (page - 1) * pageSize;
      const pagePending = current.txids.slice(0, remaining);
      // Legacy first pages can contain the entire pending prefix. Combined pages must contain
      // exactly their pending slots; a clamped page, changed count, or repetition means retry.
      if (
        current.page !== page ||
        current.unconfirmedTxs !== count ||
        pagePending.length < Math.min(remaining, pageSize) ||
        (page > 1 && current.txids.length > pageSize)
      ) {
        throw new Error('Blockbook address history changed while reading a mempool cursor; retry');
      }
      for (const txid of pagePending) {
        if (seen.has(txid)) {
          throw new Error('Blockbook returned duplicate address history while reading a mempool cursor; retry');
        }
        seen.add(txid);
        if (found) pending.push(txid);
        if (txid === cursor) found = true;
        if (pending.length === MEMPOOL_PAGE_SIZE) break;
      }
      if (pending.length === MEMPOOL_PAGE_SIZE || pagePending.length === remaining) break;
    }
    if (pending.length < MEMPOOL_PAGE_SIZE && available < count) {
      throw new BlockbookHistoryLimitError();
    }
    if (!found) {
      throw new BlockbookInputError('after_txid does not belong to this Bitcoin address history', 400);
    }
    const confirmed = await this.getFirstConfirmedTxids(address, first, pending, signal);
    if (confirmed.some((txid) => seen.has(txid))) {
      throw new Error('Blockbook address history changed while reading a mempool cursor; retry');
    }
    return { pending, confirmed };
  }

  public async getAddressTxs(
    request: { address: string; after_txid?: string },
    hydrate: (txid: string) => Promise<Transaction>,
  ): Promise<Transaction[]> {
    const { pending, confirmed } = await this.getAddressTxids(request, AbortSignal.timeout(20_000));
    const load = (txid: string, requireConfirmed: boolean) =>
      this.hydrateLimit(async () => {
        const tx = await hydrate(txid);
        if (tx.txid !== txid || (requireConfirmed && !tx.status.confirmed)) {
          throw new Error('Bitcoin history transaction did not match the selected transaction; retry');
        }
        return tx;
      });
    return Promise.all([
      ...pending.map((txid) => load(txid, false)),
      ...confirmed.map((txid) => load(txid, Boolean(request.after_txid))),
    ]);
  }
}
