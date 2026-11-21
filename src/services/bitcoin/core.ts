import axios, { isAxiosError, type AxiosInstance } from 'axios';
import { bitcoin } from '@rgbpp-sdk/btc';
import { z } from 'zod';
import type { IBitcoinDataProvider } from './interface';
import type { Block, RecommendedFees, Status, Transaction, TxOutspend } from './schema';

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Hex = z.string().regex(/^(?:[a-f0-9]{2})*$/);
const UInt32 = z.number().int().min(0).max(0xffffffff);
const Version = z.number().int().min(-0x80000000).max(0xffffffff);
const Amount = z
  .number()
  .finite()
  .min(0)
  .max(21_000_000)
  .transform((btc, ctx) => {
    // Every consensus-valid satoshi amount is representable exactly as an integer in JavaScript.
    const satoshi = Math.round(btc * 100_000_000);
    if (satoshi / 100_000_000 !== btc) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid BTC amount precision' });
      return z.NEVER;
    }
    return satoshi;
  });
const CoreOutput = z.object({
  value: Amount,
  scriptPubKey: z.object({
    hex: Hex,
    type: z.string(),
    address: z.string().optional(),
  }),
});
const CoreOutputs = z
  .array(CoreOutput.extend({ n: UInt32 }))
  .refine((outputs) => outputs.every((out, i) => out.n === i));
const CoreInputBase = z.object({ sequence: UInt32, txinwitness: z.array(Hex).optional() });
const CoreInput = z.union([
  CoreInputBase.extend({ coinbase: Hex }),
  CoreInputBase.extend({ txid: Hash, vout: UInt32, scriptSig: z.object({ hex: Hex }), prevout: CoreOutput.optional() }),
]);
const CoreStatus = z.object({ txid: Hash, blockhash: Hash.optional(), confirmations: z.number().int().optional() });
const CoreTransaction = CoreStatus.extend({
  version: Version,
  locktime: UInt32,
  size: UInt32,
  weight: UInt32,
  vin: z.array(CoreInput).min(1),
  vout: CoreOutputs,
  fee: Amount.optional(),
});
const CoreBlock = z.object({
  hash: Hash,
  height: UInt32,
  version: Version,
  time: UInt32,
  mediantime: UInt32,
  nonce: UInt32,
  bits: z.string().regex(/^[a-f0-9]{8}$/),
  difficulty: z.number().finite().nonnegative(),
  merkleroot: Hash,
  previousblockhash: Hash.optional(),
  nTx: UInt32,
  size: UInt32,
  weight: UInt32,
});
const CoreHeader = z.object({ hash: Hash, confirmations: z.number().int(), height: UInt32, time: UInt32 });
const CoreOutspend = z.tuple([
  z.object({
    txid: Hash,
    vout: UInt32,
    spendingtxid: Hash.optional(),
    spendingtx: Hex.optional(),
    blockhash: Hash.optional(),
  }),
]);
const Envelope = z.object({
  id: z.number(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number().int(), message: z.string() }).nullable().optional(),
});
const RpcMethod = {
  rawTx: 'getrawtransaction',
  block: 'getblock',
  blockHash: 'getblockhash',
  blockHeader: 'getblockheader',
  tip: 'getbestblockhash',
  broadcast: 'sendrawtransaction',
  fees: 'estimatesmartfee',
  mempool: 'getmempoolinfo',
  spending: 'gettxspendingprevout',
  chainInfo: 'getblockchaininfo',
  index: 'getindexinfo',
} as const;
type RpcMethod = (typeof RpcMethod)[keyof typeof RpcMethod];

const OUTPUT_TYPES = new Map([
  ['pubkey', 'p2pk'],
  ['pubkeyhash', 'p2pkh'],
  ['scripthash', 'p2sh'],
  ['witness_v0_keyhash', 'v0_p2wpkh'],
  ['witness_v0_scripthash', 'v0_p2wsh'],
  ['witness_v1_taproot', 'v1_p2tr'],
  ['multisig', 'multisig'],
  ['nulldata', 'op_return'],
  ['anchor', 'anchor'],
]);
const ZERO_HASH = '0'.repeat(64);
const PREVOUT_CONCURRENCY = 8;

const opcodeByNumber = new Map<number, string>(Object.entries(bitcoin.opcodes).map(([name, number]) => [number, name]));
// Core's assembly syntax interprets short pushes as numbers and annotates signature hash modes.
// Electrs shows literal bytes and push opcodes. Render from the bytes to keep the public format.
function scriptToAsm(hex: string): string {
  const script = Buffer.from(hex, 'hex');
  const parts: string[] = [];
  for (let offset = 0; offset < script.length; ) {
    const opcode = script[offset++];
    if (opcode === 0) {
      parts.push('OP_0');
    } else if (opcode <= 0x4e) {
      const width = opcode === 0x4c ? 1 : opcode === 0x4d ? 2 : opcode === 0x4e ? 4 : 0;
      if (offset + width > script.length) {
        parts.push('<unexpected end>');
        break;
      }
      parts.push(width ? 'OP_PUSHDATA' + width : 'OP_PUSHBYTES_' + opcode);
      const length = width ? script.readUIntLE(offset, width) : opcode;
      offset += width;
      if (offset + length > script.length) {
        parts.push('<push past end>');
        break;
      }
      if (length) parts.push(script.subarray(offset, offset + length).toString('hex'));
      offset += length;
    } else if (opcode === 0x4f) {
      parts.push('OP_PUSHNUM_NEG1');
    } else if (opcode >= 0x51 && opcode <= 0x60) {
      parts.push('OP_PUSHNUM_' + (opcode - 0x50));
    } else {
      parts.push(opcodeByNumber.get(opcode) ?? 'OP_RETURN_' + opcode);
    }
  }
  return parts.join(' ');
}

function output({ value, scriptPubKey }: z.infer<typeof CoreOutput>): Transaction['vout'][number] {
  const { hex, type, address } = scriptPubKey;
  const mappedType = !hex ? 'empty' : hex.startsWith('6a') ? 'op_return' : (OUTPUT_TYPES.get(type) ?? 'unknown');
  return {
    scriptpubkey: hex,
    scriptpubkey_asm: scriptToAsm(hex),
    scriptpubkey_type: mappedType,
    ...(address && { scriptpubkey_address: address }),
    value,
  };
}

export class BitcoinCoreRPCError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: number,
  ) {
    super(message);
    this.name = 'BitcoinCoreRPCError';
  }
}

class GenesisCoinbaseError extends BitcoinCoreRPCError {
  constructor() {
    super(404, 'Bitcoin Core could not find the requested transaction', -5);
  }
}

const invalid = (method: RpcMethod) => new BitcoinCoreRPCError(503, 'Invalid Bitcoin Core response for ' + method);
const parse = <S extends z.ZodTypeAny>(schema: S, value: unknown, method: RpcMethod): z.output<S> => {
  const result = schema.safeParse(value);
  if (!result.success) throw invalid(method);
  return result.data;
};

export interface BitcoinCoreClientOptions {
  url: string;
  username?: string;
  password?: string;
  timeoutMs?: number;
}

type CoreMethods =
  | 'getBaseURL'
  | 'getFeesRecommended'
  | 'postTx'
  | 'getTx'
  | 'getTxHex'
  | 'getBlock'
  | 'getBlockHeight'
  | 'getBlockHeader'
  | 'getBlockTxids'
  | 'getBlocksTipHash'
  | 'getTxOutspend';

export class BitcoinCoreClient implements Pick<IBitcoinDataProvider, CoreMethods> {
  private readonly request: AxiosInstance;
  private readonly url: string;
  private readonly timeoutMs: number;
  private id = 0;

  constructor({ url, username, password, timeoutMs = 10_000 }: BitcoinCoreClientOptions) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error('Invalid Bitcoin Core RPC URL');
    }
    if (
      !['http:', 'https:'].includes(parsedUrl.protocol) ||
      parsedUrl.username ||
      parsedUrl.password ||
      parsedUrl.search ||
      parsedUrl.hash
    ) {
      throw new Error('Bitcoin Core RPC URL must use HTTP(S) without embedded credentials, a query, or a fragment');
    }
    if ((username === undefined) !== (password === undefined)) {
      throw new Error('Bitcoin Core RPC username and password must be supplied together');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
      throw new Error('Invalid Bitcoin Core RPC timeout');
    }
    this.url = parsedUrl.href;
    this.timeoutMs = timeoutMs;
    this.request = axios.create({
      timeout: timeoutMs,
      maxRedirects: 0, // Never replay RPC requests or forward credentials to a different URL.
      proxy: false, // Core is a direct operator-configured dependency, not a public API.
      headers: { 'Content-Type': 'application/json' },
      ...(username !== undefined && password !== undefined && { auth: { username, password } }),
      validateStatus: () => true,
    });
  }

  private deadline(): AbortSignal {
    return AbortSignal.timeout(this.timeoutMs);
  }

  private async rpc<S extends z.ZodTypeAny>(
    method: RpcMethod,
    params: readonly unknown[],
    schema: S,
    signal: AbortSignal = this.deadline(),
  ): Promise<z.output<S>> {
    const id = ++this.id;
    let response;
    try {
      response = await this.request.post<unknown>(this.url, { jsonrpc: '2.0', id, method, params }, { signal });
    } catch (error) {
      // Do not retain Axios errors: they carry URL, authentication, and request payloads.
      if (signal.aborted || (isAxiosError(error) && ['ECONNABORTED', 'ETIMEDOUT'].includes(error.code ?? ''))) {
        throw new BitcoinCoreRPCError(504, 'Bitcoin Core RPC timed out');
      }
      throw new BitcoinCoreRPCError(503, 'Bitcoin Core RPC unavailable');
    }
    if (signal.aborted) throw new BitcoinCoreRPCError(504, 'Bitcoin Core RPC timed out');
    if (response.status === 401 || response.status === 403) {
      throw new BitcoinCoreRPCError(503, 'Bitcoin Core RPC authentication failed');
    }
    if ((response.status < 200 || response.status >= 300) && ![400, 404, 500].includes(response.status)) {
      throw new BitcoinCoreRPCError(503, 'Bitcoin Core RPC unavailable');
    }
    const data = parse(Envelope, response.data, method);
    if (data.id !== id) throw invalid(method);
    if (data.error) {
      const { code, message } = data.error;
      if (method === RpcMethod.rawTx && code === -5 && message.startsWith('The genesis block coinbase')) {
        throw new GenesisCoinbaseError();
      }
      if (
        method === RpcMethod.rawTx &&
        code === -5 &&
        /still in the process of being indexed|Use -txindex/.test(message)
      ) {
        throw new BitcoinCoreRPCError(503, 'Bitcoin Core transaction index is unavailable', code);
      }
      if (
        (code === -5 && [RpcMethod.rawTx, RpcMethod.block, RpcMethod.blockHeader].some((m) => m === method)) ||
        (code === -8 && method === RpcMethod.blockHash)
      ) {
        throw new BitcoinCoreRPCError(404, 'Bitcoin Core could not find the requested data', code);
      }
      if (method === RpcMethod.broadcast && [-22, -25, -26, -27].includes(code)) {
        throw new BitcoinCoreRPCError(400, 'Bitcoin Core rejected the transaction (RPC ' + code + ')', code);
      }
      if (code === -8 || code === -3) {
        throw new BitcoinCoreRPCError(400, 'Bitcoin Core rejected the request parameters', code);
      }
      throw new BitcoinCoreRPCError(503, 'Bitcoin Core RPC failed for ' + method + ' (RPC ' + code + ')', code);
    }
    if (response.status < 200 || response.status >= 300) throw invalid(method);
    return parse(schema, data.result, method);
  }

  public async getBaseURL(): Promise<string> {
    return this.url;
  }

  public async checkReady(): Promise<void> {
    const signal = this.deadline();
    const [info, index, mempool] = await Promise.all([
      this.rpc(RpcMethod.chainInfo, [], z.object({ initialblockdownload: z.boolean(), pruned: z.boolean() }), signal),
      this.rpc(
        RpcMethod.index,
        [],
        z.object({
          txindex: z.object({ synced: z.boolean() }).optional(),
          txospenderindex: z.object({ synced: z.boolean() }).optional(),
        }),
        signal,
      ),
      this.rpc(RpcMethod.mempool, [], z.object({ loaded: z.boolean() }), signal),
    ]);
    if (
      info.initialblockdownload ||
      info.pruned ||
      !index.txindex?.synced ||
      !index.txospenderindex?.synced ||
      !mempool.loaded
    ) {
      throw new BitcoinCoreRPCError(
        503,
        'Bitcoin Core requires an archive node with synced txindex and txospenderindex and a loaded mempool',
      );
    }
  }

  private async getGenesis(signal: AbortSignal) {
    const hash = await this.rpc(RpcMethod.blockHash, [0], Hash, signal);
    const block = await this.rpc(
      RpcMethod.block,
      [hash, 2],
      z.object({
        hash: Hash,
        confirmations: z.number().int(),
        time: UInt32,
        tx: z.tuple([CoreTransaction.extend({ hex: Hex })]),
      }),
      signal,
    );
    if (block.hash !== hash || block.confirmations < 1 || !('coinbase' in block.tx[0].vin[0])) {
      throw invalid(RpcMethod.block);
    }
    return {
      ...block.tx[0],
      blockhash: block.hash,
      confirmations: block.confirmations,
    };
  }

  private async getBlockStatus(hash: string, signal: AbortSignal): Promise<Transaction['status']> {
    const header = await this.rpc(RpcMethod.blockHeader, [hash, true], CoreHeader, signal);
    if (header.hash !== hash) throw invalid(RpcMethod.blockHeader);
    if (header.confirmations < 1) return { confirmed: false }; // Reorg between transaction and header reads.
    return { confirmed: true, block_hash: header.hash, block_height: header.height, block_time: header.time };
  }

  private async confirmedStatus(tx: z.infer<typeof CoreStatus>, signal: AbortSignal): Promise<Transaction['status']> {
    if (tx.confirmations === undefined || tx.confirmations < 1) return { confirmed: false };
    if (!tx.blockhash) throw invalid(RpcMethod.rawTx);
    return this.getBlockStatus(tx.blockhash, signal);
  }

  public async getTxStatus({ txid }: { txid: string }): Promise<z.infer<typeof Status>> {
    const signal = this.deadline();
    const tx = await this.rpc(RpcMethod.rawTx, [txid, 1], CoreStatus, signal).catch((error: unknown) => {
      if (error instanceof GenesisCoinbaseError) return this.getGenesis(signal);
      throw error;
    });
    if (tx.txid !== txid.toLowerCase()) throw invalid(RpcMethod.rawTx);
    return this.confirmedStatus(tx, signal);
  }

  public async getTx({ txid }: { txid: string }): Promise<Transaction> {
    const signal = this.deadline();
    const tx = await this.rpc(RpcMethod.rawTx, [txid, 2], CoreTransaction, signal).catch((error: unknown) => {
      if (error instanceof GenesisCoinbaseError) return this.getGenesis(signal);
      throw error;
    });
    if (tx.txid !== txid.toLowerCase()) throw invalid(RpcMethod.rawTx);
    const status = await this.confirmedStatus(tx, signal);
    const missing = [...new Set(tx.vin.flatMap((vin) => ('txid' in vin && !vin.prevout ? [vin.txid] : [])))];
    const previous = new Map<string, Transaction['vout']>();
    for (let i = 0; i < missing.length; i += PREVOUT_CONCURRENCY) {
      await Promise.all(
        missing.slice(i, i + PREVOUT_CONCURRENCY).map(async (prevTxid) => {
          // Verbosity 1 retrieves the parent's outputs without recursively expanding its inputs.
          try {
            const parent = await this.rpc(
              RpcMethod.rawTx,
              [prevTxid, 1],
              z.object({ txid: Hash, vout: CoreOutputs }),
              signal,
            );
            if (parent.txid !== prevTxid) throw invalid(RpcMethod.rawTx);
            previous.set(prevTxid, parent.vout.map(output));
          } catch (error) {
            if (error instanceof BitcoinCoreRPCError && error.statusCode === 404) {
              throw new BitcoinCoreRPCError(503, 'Bitcoin Core could not resolve a transaction input');
            }
            throw error;
          }
        }),
      );
    }
    const vin = tx.vin.map((entry): Transaction['vin'][number] => {
      const witness = entry.txinwitness?.length ? { witness: entry.txinwitness } : {};
      if ('coinbase' in entry) {
        return {
          txid: ZERO_HASH,
          vout: 0xffffffff,
          prevout: null,
          scriptsig: entry.coinbase,
          scriptsig_asm: scriptToAsm(entry.coinbase),
          is_coinbase: true,
          sequence: entry.sequence,
          ...witness,
        };
      }
      const prevout = entry.prevout ? output(entry.prevout) : previous.get(entry.txid)?.[entry.vout];
      if (!prevout) throw new BitcoinCoreRPCError(503, 'Bitcoin Core could not resolve a transaction input');
      return {
        txid: entry.txid,
        vout: entry.vout,
        prevout,
        scriptsig: entry.scriptSig.hex,
        scriptsig_asm: scriptToAsm(entry.scriptSig.hex),
        is_coinbase: false,
        sequence: entry.sequence,
        ...witness,
      };
    });
    const vout = tx.vout.map(output);
    const calculatedFee =
      vin.length === 1 && vin[0].is_coinbase
        ? 0
        : vin.reduce((sum, row) => sum + (row.prevout?.value ?? 0), 0) - vout.reduce((sum, row) => sum + row.value, 0);
    if (
      !Number.isSafeInteger(calculatedFee) ||
      calculatedFee < 0 ||
      (tx.fee !== undefined && tx.fee !== calculatedFee)
    ) {
      throw invalid(RpcMethod.rawTx);
    }
    return {
      txid: tx.txid,
      version: tx.version >>> 0,
      locktime: tx.locktime,
      vin,
      vout,
      size: tx.size,
      weight: tx.weight,
      fee: tx.fee ?? calculatedFee,
      status,
    };
  }

  public async getTxHex({ txid }: { txid: string }): Promise<string> {
    const signal = this.deadline();
    return this.rpc(RpcMethod.rawTx, [txid, 0], Hex.min(2), signal).catch(async (error: unknown) => {
      if (!(error instanceof GenesisCoinbaseError)) throw error;
      const tx = await this.getGenesis(signal);
      if (tx.txid !== txid.toLowerCase()) throw invalid(RpcMethod.block);
      return tx.hex;
    });
  }

  public async getBlock({ hash }: { hash: string }): Promise<Block> {
    const block = await this.rpc(RpcMethod.block, [hash, 1], CoreBlock);
    if (block.hash !== hash.toLowerCase() || (block.height > 0 && !block.previousblockhash))
      throw invalid(RpcMethod.block);
    return {
      id: block.hash,
      height: block.height,
      version: block.version >>> 0,
      timestamp: block.time,
      tx_count: block.nTx,
      size: block.size,
      weight: block.weight,
      merkle_root: block.merkleroot,
      previousblockhash: block.previousblockhash ?? ZERO_HASH, // The existing API requires a string, including for genesis.
      mediantime: block.mediantime,
      nonce: block.nonce,
      bits: parseInt(block.bits, 16),
      difficulty: block.difficulty,
    };
  }

  public async getBlockHeight({ height }: { height: number }): Promise<string> {
    return this.rpc(RpcMethod.blockHash, [height], Hash);
  }

  public async getBlockHeader({ hash }: { hash: string }): Promise<string> {
    return this.rpc(RpcMethod.blockHeader, [hash, false], Hex.length(160));
  }

  public async getBlockTxids({ hash }: { hash: string }): Promise<string[]> {
    const block = await this.rpc(RpcMethod.block, [hash, 1], z.object({ hash: Hash, nTx: UInt32, tx: z.array(Hash) }));
    if (block.hash !== hash.toLowerCase() || block.nTx !== block.tx.length || !block.nTx)
      throw invalid(RpcMethod.block);
    return block.tx;
  }

  public async getBlocksTipHash(): Promise<string> {
    return this.rpc(RpcMethod.tip, [], Hash);
  }

  public async postTx({ txhex }: { txhex: string }): Promise<string> {
    // Keep Core's default max fee and burn limits; never retry a possibly-accepted broadcast here.
    return this.rpc(RpcMethod.broadcast, [txhex], Hash);
  }

  public async getFeesRecommended(): Promise<RecommendedFees> {
    const signal = this.deadline();
    const [mempool, ...estimates] = await Promise.all([
      this.rpc(RpcMethod.mempool, [], z.object({ mempoolminfee: Amount, minrelaytxfee: Amount }), signal),
      ...[2, 3, 6, 144].map((target) =>
        this.rpc(
          RpcMethod.fees,
          [target, 'economical'],
          z
            .object({
              feerate: Amount.optional(),
              errors: z.array(z.string()).min(1).optional(),
            })
            .refine(({ feerate, errors }) => feerate !== undefined || errors !== undefined),
          signal,
        ),
      ),
    ]);
    // Core returns BTC/kvB. Amount converts to sat/kvB; round up to a tenth of sat/vB.
    // An explicit insufficient-data response uses the next slower estimate, then the node's
    // actual relay/mempool floor. Transport/protocol errors are not estimates.
    const rate = (satoshiPerKvb: number) => Math.ceil(satoshiPerKvb / 100) / 10;
    const minimumFee = rate(Math.max(mempool.mempoolminfee, mempool.minrelaytxfee));
    const recommendation = estimates.reduceRight<number[]>((slower, next) => {
      const floor = slower[0] ?? minimumFee;
      return [next.feerate === undefined ? floor : Math.max(floor, rate(next.feerate)), ...slower];
    }, []);
    const [fastestFee, halfHourFee, hourFee, economyFee] = recommendation;
    return { fastestFee, halfHourFee, hourFee, economyFee, minimumFee };
  }

  public async getTxOutspend({ txid, vout }: { txid: string; vout: number }): Promise<TxOutspend> {
    txid = txid.toLowerCase();
    if (!Hash.safeParse(txid).success || !Number.isInteger(vout) || vout < 0) {
      throw new BitcoinCoreRPCError(400, 'Invalid Bitcoin outpoint');
    }
    // The RPC takes a signed 32-bit output index. Such a high index cannot exist in a valid Bitcoin transaction.
    if (vout > 0x7fffffff) throw new BitcoinCoreRPCError(404, 'Bitcoin transaction output not found');
    const signal = this.deadline();
    // Core 31+ searches both mempool and txospenderindex and returns the exact spending bytes.
    const [row] = await this.rpc(
      RpcMethod.spending,
      [[{ txid, vout }], { mempool_only: false, return_spending_tx: true }],
      CoreOutspend,
      signal,
    );
    if (row.txid !== txid || row.vout !== vout) throw invalid(RpcMethod.spending);
    if (!row.spendingtxid && !row.spendingtx && !row.blockhash) {
      // Core returns an empty result row both for an unspent and a nonexistent outpoint.
      const funding = await this.rpc(
        RpcMethod.rawTx,
        [txid, 1],
        z.object({ txid: Hash, vout: CoreOutputs }),
        signal,
      ).catch((error: unknown) => {
        if (error instanceof GenesisCoinbaseError) return this.getGenesis(signal);
        throw error;
      });
      if (funding.txid !== txid) throw invalid(RpcMethod.rawTx);
      if (!funding.vout[vout]) throw new BitcoinCoreRPCError(404, 'Bitcoin transaction output not found');
      return { spent: false };
    }
    if (!row.spendingtxid || !row.spendingtx) throw invalid(RpcMethod.spending);
    let spending: bitcoin.Transaction;
    try {
      spending = bitcoin.Transaction.fromHex(row.spendingtx);
    } catch {
      throw invalid(RpcMethod.spending);
    }
    const index = spending.ins.findIndex(
      (input) => input.index === vout && Buffer.from(input.hash).reverse().toString('hex') === row.txid,
    );
    if (index < 0 || spending.getId() !== row.spendingtxid) throw invalid(RpcMethod.spending);
    const status = row.blockhash ? await this.getBlockStatus(row.blockhash, signal) : { confirmed: false };
    if (row.blockhash && !status.confirmed) {
      throw new BitcoinCoreRPCError(503, 'Bitcoin Core chain changed during the outspend lookup; retry');
    }
    return { spent: true, txid: row.spendingtxid, vout: index, status };
  }
}
