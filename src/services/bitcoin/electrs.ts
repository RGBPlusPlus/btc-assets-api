import axios, { AxiosInstance } from 'axios';
import { IBitcoinDataProvider } from './interface';
import { Block, RecommendedFees, Transaction, UTXO, TxOutspend } from './schema';

export class ElectrsClient implements IBitcoinDataProvider {
  private request: AxiosInstance;

  constructor(
    private baseURL: string,
    timeoutMs?: number,
  ) {
    this.request = axios.create({
      baseURL,
      timeout: timeoutMs,
    });
  }

  public async getBaseURL(): Promise<string> {
    return this.baseURL;
  }

  /**
   * Rounds up a number to the specified number of decimal places
   * @param value - The number to round up
   * @param decimalPlaces - Number of decimal places (default: 1)
   * @returns The rounded number
   */
  private roundUpTo(value: number, decimalPlaces: number = 1): number {
    const factor = Math.pow(10, decimalPlaces);
    return Math.ceil(value * factor) / factor;
  }

  public async getFeesRecommended(): Promise<RecommendedFees> {
    // The available confirmation targets are 1-25, 144, 504 and 1008 blocks.
    // https://github.com/blockstream/esplora/blob/master/API.md#get-fee-estimates
    const response = await this.request.get<Record<string, number>>('/fee-estimates');
    const data = response.data;

    const defaultFee = 1;

    return {
      fastestFee: this.roundUpTo(data['1'] ?? defaultFee),
      halfHourFee: this.roundUpTo(data['3'] ?? defaultFee),
      hourFee: this.roundUpTo(data['6'] ?? defaultFee),
      economyFee: this.roundUpTo(data['3'] ?? defaultFee),
      minimumFee: this.roundUpTo(data['144'] ?? defaultFee),
    };
  }

  public async postTx({ txhex }: { txhex: string }) {
    const response = await this.request.post('/tx', txhex);
    return response.data;
  }

  public async getAddressTxsUtxo({ address }: { address: string }) {
    const response = await this.request.get<UTXO[]>(`/address/${address}/utxo`);
    return response.data;
  }

  public async getAddressTxs({ address, after_txid }: { address: string; after_txid?: string }) {
    let url = `/address/${address}/txs`;
    if (after_txid) {
      url += `?after_txid=${after_txid}`;
    }
    const response = await this.request.get<Transaction[]>(url);
    return response.data.map((tx) => Transaction.parse(tx));
  }

  public async getTx({ txid }: { txid: string }) {
    const response = await this.request.get<Transaction>(`/tx/${txid}`);
    return Transaction.parse(response.data);
  }

  public async getTxHex({ txid }: { txid: string }) {
    const response = await this.request.get<string>(`/tx/${txid}/hex`);
    return response.data;
  }

  public async getBlock({ hash }: { hash: string }) {
    const response = await this.request.get<Block>(`/block/${hash}`);
    return Block.parse(response.data);
  }

  public async getBlockHeight({ height }: { height: number }) {
    const response = await this.request.get<string>(`/block-height/${height}`);
    return response.data;
  }

  public async getBlockHeader({ hash }: { hash: string }) {
    const response = await this.request.get<string>(`/block/${hash}/header`);
    return response.data;
  }

  public async getBlockTxids({ hash }: { hash: string }) {
    const response = await this.request.get<string[]>(`/block/${hash}/txids`);
    return response.data;
  }

  public async getBlocksTipHash() {
    const response = await this.request.get<string>('/blocks/tip/hash');
    return response.data;
  }

  public async getTxOutspend({ txid, vout }: { txid: string; vout: number }) {
    const response = await this.request.get<TxOutspend>(`/tx/${txid}/outspend/${vout}`);
    return response.data;
  }
}
