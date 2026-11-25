import { describe, beforeEach, afterEach, expect, test, vi } from 'vitest';
import TransactionProcessor, { ITransactionRequest } from '../../src/services/transaction';
import container from '../../src/container';
import { CKBVirtualResult, InputCell, OutputCell } from '../../src/routes/rgbpp/types';
import { ChainInfo, Transaction } from '../../src/routes/bitcoin/types';
import { buildPreLockArgs, calculateCommitment, genRgbppLockScript } from '@rgbpp-sdk/ckb';
import { DelayedError, Job, UnrecoverableError } from 'bullmq';
import { Transaction as BitcoinTransaction, payments } from 'bitcoinjs-lib';
import { HttpStatusCode } from 'axios';
import { BitcoinClientAPIError } from '../../src/services/bitcoin';

const commitment = calculateCommitment({
  inputs: [] as InputCell[],
  outputs: [] as OutputCell[],
} as CKBVirtualResult['ckbRawTx']);

describe('transactionProcessor', () => {
  let transactionProcessor: TransactionProcessor;
  const cradle = container.cradle;

  beforeEach(async () => {
    transactionProcessor = new TransactionProcessor(cradle);
  });

  test('verifyTransaction: should return true for valid transaction', async () => {
    vi.spyOn(
      transactionProcessor as unknown as {
        getCommitmentFromBtcTx: (txid: string) => Buffer;
      },
      'getCommitmentFromBtcTx',
    ).mockReturnValueOnce(Buffer.from(commitment, 'hex'));

    const transactionRequest: ITransactionRequest = {
      txid: 'bb8c92f11920824db22b379c0ef491dea2d819e721d5df296bebc67a0568ea0f',
      ckbVirtualResult: {
        ckbRawTx: { inputs: [] as InputCell[], outputs: [] as OutputCell[] } as CKBVirtualResult['ckbRawTx'],
        commitment,
        sumInputsCapacity: '1000',
        needPaymasterCell: false,
      },
    };
    const btcTx = await cradle.bitcoin.getTx({ txid: transactionRequest.txid });
    const isValid = await transactionProcessor.verifyTransaction(transactionRequest, btcTx);
    expect(isValid).toBe(true);
  });

  test('verifyTransaction: should return false for mismatch commitment', async () => {
    vi.spyOn(
      transactionProcessor as unknown as {
        getCommitmentFromBtcTx: (txid: string) => Buffer;
      },
      'getCommitmentFromBtcTx',
    ).mockReturnValueOnce(Buffer.from('mismatchcommitment', 'hex'));

    const transactionRequest: ITransactionRequest = {
      txid: 'bb8c92f11920824db22b379c0ef491dea2d819e721d5df296bebc67a0568ea0f',
      ckbVirtualResult: {
        ckbRawTx: { inputs: [] as InputCell[], outputs: [] as OutputCell[] } as CKBVirtualResult['ckbRawTx'],
        commitment,
        sumInputsCapacity: '1000',
        needPaymasterCell: false,
      },
    };
    const btcTx = await cradle.bitcoin.getTx({ txid: transactionRequest.txid });
    const isValid = await transactionProcessor.verifyTransaction(transactionRequest, btcTx);
    expect(isValid).toBe(false);
  });

  test('verifyTransaction: should return false for mismatch ckb tx', async () => {
    const commitment = 'mismatchcommitment';
    vi.spyOn(
      transactionProcessor as unknown as {
        getCommitmentFromBtcTx: (txid: string) => Buffer;
      },
      'getCommitmentFromBtcTx',
    ).mockReturnValueOnce(Buffer.from(commitment, 'hex'));

    const transactionRequest: ITransactionRequest = {
      txid: 'bb8c92f11920824db22b379c0ef491dea2d819e721d5df296bebc67a0568ea0f',
      ckbVirtualResult: {
        ckbRawTx: { inputs: [] as InputCell[], outputs: [] as OutputCell[] } as CKBVirtualResult['ckbRawTx'],
        commitment,
        sumInputsCapacity: '1000',
        needPaymasterCell: false,
      },
    };
    const btcTx = await cradle.bitcoin.getTx({ txid: transactionRequest.txid });
    const isValid = await transactionProcessor.verifyTransaction(transactionRequest, btcTx);
    expect(isValid).toBe(false);
  });

  test('verifyTransaction: should throw TransactionNotConfirmedError for unconfirmed transaction', async () => {
    vi.spyOn(
      transactionProcessor as unknown as {
        getCommitmentFromBtcTx: (txid: string) => Buffer;
      },
      'getCommitmentFromBtcTx',
    ).mockReturnValueOnce(Buffer.from(commitment, 'hex'));
    vi.spyOn(transactionProcessor['cradle']['bitcoin'], 'getTx').mockResolvedValueOnce({
      status: { confirmed: false, block_height: 0 },
    } as unknown as Transaction);

    const transactionRequest: ITransactionRequest = {
      txid: 'bb8c92f11920824db22b379c0ef491dea2d819e721d5df296bebc67a0568ea0f',
      ckbVirtualResult: {
        ckbRawTx: { inputs: [] as InputCell[], outputs: [] as OutputCell[] } as CKBVirtualResult['ckbRawTx'],
        commitment,
        sumInputsCapacity: '1000',
        needPaymasterCell: false,
      },
    };

    const btcTx = await cradle.bitcoin.getTx({ txid: transactionRequest.txid });
    await expect(
      transactionProcessor.verifyTransaction(transactionRequest, btcTx),
    ).rejects.toThrowErrorMatchingSnapshot();
  });

  test('enqueueTransaction: should be add transaction request to queue', async () => {
    const transactionRequest: ITransactionRequest = {
      txid: '0x123',
      ckbVirtualResult: {
        ckbRawTx: {} as CKBVirtualResult['ckbRawTx'],
        commitment: '0x123',
        sumInputsCapacity: '1000',
        needPaymasterCell: false,
      },
    };

    await transactionProcessor.enqueueTransaction(transactionRequest);
    const jobs = await transactionProcessor['queue'].getJobs('delayed');
    const jobFromApi = await transactionProcessor['queue'].getJob(transactionRequest.txid);
    const jobFromList = jobs.find((row) => row.id === transactionRequest.txid);

    expect(jobFromApi).toBeDefined();
    expect(jobFromApi!.id).toStrictEqual(jobFromList?.id);
    expect(jobFromApi!.delay).toBe(cradle.env.TRANSACTION_QUEUE_JOB_DELAY);
  });

  test('retryMissingTransactions: should be retry transaction job when missing', async () => {
    vi.spyOn(cradle.bitcoin, 'getBlockchainInfo').mockResolvedValue({
      blocks: 123456,
    } as unknown as ChainInfo);
    vi.spyOn(cradle.bitcoin, 'getBlockHeight').mockResolvedValue('00000000abcdefghijklmnopqrstuvwxyz');
    vi.spyOn(cradle.bitcoin, 'getBlockTxids').mockResolvedValue([
      'bb8c92f11920824db22b379c0ef491dea2d819e721d5df296bebc67a0568ea0f',
      '8ea0fbb8c92f11920824db22b379c0ef491dea2d819e721d5df296bebc67a056',
      '8eb22b379c0ef491dea2d819e721d5df296bebc67a056a0fbb8c92f11920824d',
    ]);
    const retry = vi.fn();
    vi.spyOn(transactionProcessor['queue'], 'getJobs').mockResolvedValue([
      {
        id: 'bb8c92f11920824db22b379c0ef491dea2d819e721d5df296bebc67a0568ea0f',
        retry,
      } as unknown as Job,
    ]);

    await transactionProcessor.retryMissingTransactions();

    expect(retry).toHaveBeenCalled();
  });

  test('retryMissingTransactions: should not retry transaction job when not match', async () => {
    vi.spyOn(cradle.bitcoin, 'getBlockchainInfo').mockResolvedValue({
      blocks: 123456,
    } as unknown as ChainInfo);
    vi.spyOn(cradle.bitcoin, 'getBlockHeight').mockResolvedValue('00000000abcdefghijklmnopqrstuvwxyz');
    vi.spyOn(cradle.bitcoin, 'getBlockTxids').mockResolvedValue([
      'bb8c92f11920824db22b379c0ef491dea2d819e721d5df296bebc67a0568ea0f',
      '8ea0fbb8c92f11920824db22b379c0ef491dea2d819e721d5df296bebc67a056',
      '8eb22b379c0ef491dea2d819e721d5df296bebc67a056a0fbb8c92f11920824d',
    ]);
    const retry = vi.fn();
    vi.spyOn(transactionProcessor['queue'], 'getJobs').mockResolvedValue([
      {
        id: 'bb8c92f119208248ea0fdb22b379c0ef491dea2d819e721d5df296bebc67a056',
        retry,
      } as unknown as Job,
    ]);

    await transactionProcessor.retryMissingTransactions();

    expect(retry).not.toHaveBeenCalled();
  });
});

describe('transactionProcessor: submitTransaction', () => {
  let transactionProcessor: TransactionProcessor;
  const cradle = container.cradle;

  const ckbVirtualResult: CKBVirtualResult = {
    ckbRawTx: {
      cellDeps: [] as CKBVirtualResult['ckbRawTx']['cellDeps'],
      inputs: [] as InputCell[],
      outputs: [] as OutputCell[],
    } as CKBVirtualResult['ckbRawTx'],
    commitment,
    sumInputsCapacity: '1000',
    needPaymasterCell: false,
  };

  // each seed gives a different txid
  function buildBtcTx(seed: number, options: { opReturnData?: string; witness?: string } = {}) {
    const { opReturnData = commitment, witness } = options;
    const tx = new BitcoinTransaction();
    tx.version = 2;
    tx.addInput(Buffer.alloc(32, seed), 0);
    tx.addOutput(Buffer.from(`0014${'00'.repeat(20)}`, 'hex'), 546);
    const opReturnScript = payments.embed({ data: [Buffer.from(opReturnData, 'hex')] }).output!;
    tx.addOutput(opReturnScript, 0);
    if (witness) {
      tx.setWitness(0, [Buffer.from(witness, 'hex')]);
    }
    return {
      txid: tx.getId(),
      wtxid: Buffer.from(tx.getHash(true)).reverse().toString('hex'),
      btcTxHex: tx.toHex(),
      prevTxid: Buffer.alloc(32, seed).reverse().toString('hex'),
      opReturnScript: opReturnScript.toString('hex'),
    };
  }

  function createBitcoinClientAPIError(message: string, statusCode: number) {
    const error = new BitcoinClientAPIError(message);
    error.statusCode = statusCode;
    return error;
  }

  function mockJob(txid: string, options: { timestamp?: number; ckbVirtualResult?: CKBVirtualResult } = {}) {
    const job = {
      id: txid,
      timestamp: options.timestamp ?? Date.now(),
      data: { txid, ckbVirtualResult: options.ckbVirtualResult ?? ckbVirtualResult },
      moveToDelayed: vi.fn(),
      updateData: vi.fn(async (data: ITransactionRequest) => {
        job.data = data;
      }),
    };
    return job as unknown as Job<ITransactionRequest>;
  }

  function mockRecordJobError() {
    vi.spyOn(
      transactionProcessor as unknown as { recordJobError: () => Promise<void> },
      'recordJobError',
    ).mockResolvedValue();
  }

  async function submit(btcTxHex: string, result: CKBVirtualResult = ckbVirtualResult) {
    return transactionProcessor.submitTransaction({ btcTxHex, ckbVirtualResult: result });
  }

  // submit with the broadcast failing, so only the submission is saved
  async function saveSubmission(btcTxHex: string, result: CKBVirtualResult = ckbVirtualResult) {
    vi.spyOn(cradle.bitcoin, 'postTx').mockRejectedValueOnce(
      createBitcoinClientAPIError('Connection error', HttpStatusCode.ServiceUnavailable),
    );
    vi.spyOn(cradle.bitcoin, 'getTx').mockRejectedValueOnce(
      createBitcoinClientAPIError('Connection error', HttpStatusCode.ServiceUnavailable),
    );
    await submit(btcTxHex, result);
    vi.restoreAllMocks();
  }

  function getSubmissionKey(txid: string) {
    return `rgbpp-transaction-submission:${txid}`;
  }

  // pretend the submission was made `age` ms ago
  async function ageSubmission(txid: string, age: number) {
    await cradle.redis.hset(getSubmissionKey(txid), 'createdAt', Date.now() - age);
  }

  // found but not confirmed yet
  function mockUnconfirmedBtcTx(txid: string, opReturnScript: string) {
    vi.spyOn(cradle.bitcoin, 'getTx').mockResolvedValue({
      txid,
      vout: [{ scriptpubkey_type: 'op_return', scriptpubkey: opReturnScript }],
      status: { confirmed: false },
    } as unknown as Transaction);
  }

  beforeEach(async () => {
    transactionProcessor = new TransactionProcessor(cradle);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('submitTransaction: should save the submission before broadcasting the transaction', async () => {
    const { txid, btcTxHex } = buildBtcTx(1);
    const postTx = vi.spyOn(cradle.bitcoin, 'postTx').mockImplementation(async () => {
      expect(await transactionProcessor.getSubmission(txid)).toMatchObject({
        ckbVirtualResult,
        btcTxHexes: [btcTxHex],
      });
      expect(await transactionProcessor.getTransactionRequest(txid)).toBeDefined();
      return txid;
    });

    const { job, broadcastError } = await submit(btcTxHex);

    expect(job.id).toBe(txid);
    expect(broadcastError).toBeUndefined();
    expect(postTx).toHaveBeenCalledWith({ txhex: btcTxHex });
  });

  test('submitTransaction: should be idempotent when retrying the same request', async () => {
    const { txid, btcTxHex } = buildBtcTx(2);
    vi.spyOn(cradle.bitcoin, 'postTx').mockResolvedValueOnce(txid);
    await submit(btcTxHex);

    vi.spyOn(cradle.bitcoin, 'postTx').mockRejectedValueOnce(
      createBitcoinClientAPIError(
        'sendrawtransaction RPC error: {"code":-27,"message":"Transaction already in block chain"}',
        HttpStatusCode.BadRequest,
      ),
    );
    vi.spyOn(cradle.bitcoin, 'getTx').mockResolvedValueOnce({ txid } as unknown as Transaction);
    const { job, broadcastError } = await submit(btcTxHex);

    expect(job.id).toBe(txid);
    expect(broadcastError).toBeUndefined();
    expect(await job.getState()).toBe('delayed');
    expect(await transactionProcessor.getSubmission(txid)).toMatchObject({ ckbVirtualResult, btcTxHexes: [btcTxHex] });
  });

  test('submitTransaction: should reject invalid transaction hex', async () => {
    const postTx = vi.spyOn(cradle.bitcoin, 'postTx');

    await expect(submit('deadbeef')).rejects.toMatchObject({ statusCode: HttpStatusCode.BadRequest });
    expect(postTx).not.toHaveBeenCalled();
  });

  test('submitTransaction: should reject odd-length transaction hex', async () => {
    const { txid, btcTxHex } = buildBtcTx(24);
    const postTx = vi.spyOn(cradle.bitcoin, 'postTx');

    // the extra half byte is dropped, so it still parses
    expect(BitcoinTransaction.fromHex(`${btcTxHex}f`).getId()).toBe(txid);
    await expect(submit(`${btcTxHex}f`)).rejects.toMatchObject({ statusCode: HttpStatusCode.BadRequest });
    expect(postTx).not.toHaveBeenCalled();
    expect(await transactionProcessor.getSubmission(txid)).toBeNull();
  });

  test('submitTransaction: should save and broadcast the canonical transaction hex', async () => {
    const { txid, btcTxHex } = buildBtcTx(25);
    const postTx = vi.spyOn(cradle.bitcoin, 'postTx').mockResolvedValue(txid);

    await submit(btcTxHex.toUpperCase());
    await submit(btcTxHex);

    expect(postTx).toHaveBeenNthCalledWith(1, { txhex: btcTxHex });
    expect(await transactionProcessor.getSubmission(txid)).toMatchObject({ ckbVirtualResult, btcTxHexes: [btcTxHex] });
  });

  test('submitTransaction: should reject mismatched commitment', async () => {
    const { txid, btcTxHex } = buildBtcTx(3, { opReturnData: '00'.repeat(32) });
    const postTx = vi.spyOn(cradle.bitcoin, 'postTx');

    await expect(submit(btcTxHex)).rejects.toMatchObject({
      statusCode: HttpStatusCode.BadRequest,
      message: `Commitment mismatch between the Bitcoin transaction and the CKB virtual result: ${txid}`,
    });
    expect(postTx).not.toHaveBeenCalled();
    expect(await transactionProcessor.getTransactionRequest(txid)).toBeUndefined();
    expect(await transactionProcessor.getSubmission(txid)).toBeNull();
  });

  test('submitTransaction: should reject a different ckb virtual result for the same transaction', async () => {
    const { txid, btcTxHex } = buildBtcTx(4);
    vi.spyOn(cradle.bitcoin, 'postTx').mockResolvedValue(txid);
    await submit(btcTxHex);

    await expect(submit(btcTxHex, { ...ckbVirtualResult, sumInputsCapacity: '2000' })).rejects.toMatchObject({
      statusCode: HttpStatusCode.Conflict,
    });
  });

  test('submitTransaction: should keep the submission when concurrent broadcasts are uncertain', async () => {
    const { txid, btcTxHex } = buildBtcTx(5);
    vi.spyOn(cradle.bitcoin, 'postTx')
      .mockResolvedValueOnce(txid)
      .mockRejectedValueOnce(
        createBitcoinClientAPIError(
          'sendrawtransaction RPC error: {"code":-27,"message":"Transaction already in block chain"}',
          HttpStatusCode.BadRequest,
        ),
      );
    vi.spyOn(cradle.bitcoin, 'getTx').mockRejectedValue(
      createBitcoinClientAPIError('Service Unavailable', HttpStatusCode.ServiceUnavailable),
    );

    const results = await Promise.all([submit(btcTxHex), submit(btcTxHex)]);

    expect(results.map(({ job }) => job.id)).toEqual([txid, txid]);
    expect(results.filter(({ broadcastError }) => broadcastError)).toHaveLength(1);
    expect(await transactionProcessor.getTransactionRequest(txid)).toBeDefined();
    expect(await transactionProcessor.getSubmission(txid)).toMatchObject({ ckbVirtualResult, btcTxHexes: [btcTxHex] });
  });

  test('submitTransaction: should report the broadcast error even if its message is empty', async () => {
    const { txid, btcTxHex } = buildBtcTx(35);
    // e.g. an upstream 503 with an empty body
    vi.spyOn(cradle.bitcoin, 'postTx').mockRejectedValueOnce(
      createBitcoinClientAPIError('', HttpStatusCode.ServiceUnavailable),
    );
    vi.spyOn(cradle.bitcoin, 'getTx').mockRejectedValueOnce(
      createBitcoinClientAPIError('Transaction not found', HttpStatusCode.NotFound),
    );

    const { broadcastError } = await submit(btcTxHex);

    expect(broadcastError).toBe('Bitcoin API error, status 503');
    expect(await transactionProcessor.getSubmission(txid)).toMatchObject({ btcTxHexes: [btcTxHex] });
  });

  test('submitTransaction: should keep the submission when the broadcast is rate limited', async () => {
    const { txid, btcTxHex } = buildBtcTx(6);
    vi.spyOn(cradle.bitcoin, 'postTx').mockRejectedValueOnce(
      createBitcoinClientAPIError('Too Many Requests', HttpStatusCode.TooManyRequests),
    );
    vi.spyOn(cradle.bitcoin, 'getTx').mockRejectedValueOnce(
      createBitcoinClientAPIError('Transaction not found', HttpStatusCode.NotFound),
    );

    const { job, broadcastError } = await submit(btcTxHex);

    expect(job.id).toBe(txid);
    expect(broadcastError).toBe('Too Many Requests');
    expect(await transactionProcessor.getTransactionRequest(txid)).toBeDefined();
    expect(await transactionProcessor.getSubmission(txid)).toMatchObject({ ckbVirtualResult, btcTxHexes: [btcTxHex] });
  });

  test('submitTransaction: should save the submission when the job is created concurrently by /ckb-tx', async () => {
    const { txid, btcTxHex } = buildBtcTx(7);
    // /ckb-tx creates the job right after submitTransaction looked for it
    await transactionProcessor.enqueueTransaction({ txid, ckbVirtualResult });
    const getTransactionRequest = transactionProcessor.getTransactionRequest.bind(transactionProcessor);
    vi.spyOn(transactionProcessor, 'getTransactionRequest')
      .mockResolvedValueOnce(undefined)
      .mockImplementation(getTransactionRequest);

    await saveSubmission(btcTxHex);

    expect(await transactionProcessor.getSubmission(txid)).toMatchObject({ ckbVirtualResult, btcTxHexes: [btcTxHex] });
  });

  test('submitTransaction: should accept the same request after the job data is changed by the worker', async () => {
    const { txid, btcTxHex } = buildBtcTx(8);
    vi.spyOn(cradle.bitcoin, 'postTx').mockResolvedValue(txid);
    const { job } = await submit(btcTxHex);
    // what fixPoolRejectedTransactionByMinFeeRate does
    await job.updateData({
      txid,
      ckbVirtualResult: {
        ...ckbVirtualResult,
        ckbRawTx: {
          ...ckbVirtualResult.ckbRawTx,
          cellDeps: [{ outPoint: { txHash: `0x${'11'.repeat(32)}`, index: '0x0' }, depType: 'depGroup' }],
        },
        needPaymasterCell: true,
      },
    });

    const result = await submit(btcTxHex);

    expect(result.job.id).toBe(txid);
  });

  test('submitTransaction: should take over the job created by /ckb-tx with an invalid ckb virtual result', async () => {
    const { txid, btcTxHex } = buildBtcTx(13);
    const invalidCkbVirtualResult = { ...ckbVirtualResult, commitment: 'ff'.repeat(32) };
    await transactionProcessor.enqueueTransaction({ txid, ckbVirtualResult: invalidCkbVirtualResult });

    await saveSubmission(btcTxHex);

    expect(await transactionProcessor.getSubmission(txid)).toMatchObject({ ckbVirtualResult, btcTxHexes: [btcTxHex] });
  });

  test('submitTransaction: should resume the failed job before broadcasting', async () => {
    const { txid, btcTxHex } = buildBtcTx(14);
    const job = {
      id: txid,
      data: { txid, ckbVirtualResult },
      getState: vi.fn().mockResolvedValue('failed'),
      retry: vi.fn(),
    } as unknown as Job<ITransactionRequest>;
    vi.spyOn(transactionProcessor, 'getTransactionRequest').mockResolvedValue(job);
    vi.spyOn(cradle.bitcoin, 'getTxOutspend').mockResolvedValue({ spent: false });
    const postTx = vi.spyOn(cradle.bitcoin, 'postTx').mockImplementation(async () => {
      expect(job.retry).toHaveBeenCalledWith('failed');
      return txid;
    });

    await submit(btcTxHex);

    expect(postTx).toHaveBeenCalled();
  });

  test('submitTransaction: should keep all signed transactions with the same txid', async () => {
    const invalid = buildBtcTx(15, { witness: 'aa' });
    const resigned = buildBtcTx(15, { witness: 'bb' });
    expect(resigned.txid).toBe(invalid.txid);

    await saveSubmission(invalid.btcTxHex);
    await saveSubmission(resigned.btcTxHex);

    const submission = await transactionProcessor.getSubmission(invalid.txid);
    // newest first
    expect(submission?.btcTxHexes).toEqual([resigned.btcTxHex, invalid.btcTxHex]);
  });

  test('submitTransaction: should expire the submission if it is not processed anymore', async () => {
    const { txid, btcTxHex } = buildBtcTx(26);
    await saveSubmission(btcTxHex);

    const ttl = await cradle.redis.ttl(getSubmissionKey(txid));
    expect(ttl).toBeGreaterThan(29 * 24 * 60 * 60);
    expect(ttl).toBeLessThanOrEqual(30 * 24 * 60 * 60);
  });

  test('submitTransaction: should reject the ckb virtual result that can not be parsed', async () => {
    const { txid, btcTxHex } = buildBtcTx(27);
    const invalidLock = { ...genRgbppLockScript(buildPreLockArgs(1), false), args: '0x01' };
    const postTx = vi.spyOn(cradle.bitcoin, 'postTx');

    await expect(
      submit(btcTxHex, {
        ...ckbVirtualResult,
        ckbRawTx: {
          ...ckbVirtualResult.ckbRawTx,
          outputs: [{ capacity: '0x0', lock: invalidLock }] as OutputCell[],
          outputsData: ['0x'],
        },
      }),
    ).rejects.toMatchObject({
      statusCode: HttpStatusCode.BadRequest,
      message: expect.stringContaining('Invalid CKB virtual result'),
    });
    expect(postTx).not.toHaveBeenCalled();
    expect(await transactionProcessor.getSubmission(txid)).toBeNull();
  });

  test('submitTransaction: should not resume the failed job if the transaction is conflicted', async () => {
    const { txid, btcTxHex } = buildBtcTx(28);
    const job = {
      id: txid,
      data: { txid, ckbVirtualResult },
      getState: vi.fn().mockResolvedValue('failed'),
      retry: vi.fn(),
    } as unknown as Job<ITransactionRequest>;
    vi.spyOn(transactionProcessor, 'getTransactionRequest').mockResolvedValue(job);
    vi.spyOn(cradle.bitcoin, 'getTxOutspend').mockResolvedValue({
      spent: true,
      txid: 'ff'.repeat(32),
      vout: 0,
      status: { confirmed: true, block_height: 100 },
    } as unknown as Awaited<ReturnType<typeof cradle.bitcoin.getTxOutspend>>);
    const postTx = vi.spyOn(cradle.bitcoin, 'postTx');

    await expect(submit(btcTxHex)).rejects.toMatchObject({ statusCode: HttpStatusCode.Conflict });
    expect(job.retry).not.toHaveBeenCalled();
    expect(postTx).not.toHaveBeenCalled();
    expect(await transactionProcessor.getSubmission(txid)).toBeNull();
  });

  test('submitTransaction: should process the delayed job sooner when a new signed transaction is submitted', async () => {
    const first = buildBtcTx(29, { witness: 'aa' });
    const resigned = buildBtcTx(29, { witness: 'bb' });
    vi.spyOn(cradle.bitcoin, 'postTx').mockRejectedValue(
      createBitcoinClientAPIError('Connection error', HttpStatusCode.ServiceUnavailable),
    );
    vi.spyOn(cradle.bitcoin, 'getTx').mockRejectedValue(
      createBitcoinClientAPIError('Connection error', HttpStatusCode.ServiceUnavailable),
    );
    const changeDelay = vi.spyOn(Job.prototype, 'changeDelay');

    await submit(first.btcTxHex);
    // same version again, nothing new
    await submit(first.btcTxHex);
    expect(changeDelay).not.toHaveBeenCalled();

    await submit(resigned.btcTxHex);
    expect(changeDelay).toHaveBeenCalledWith(cradle.env.TRANSACTION_QUEUE_JOB_DELAY);
  });

  test('submitTransaction: should read the submission before it is applied to the job created by /ckb-tx', async () => {
    const { txid, btcTxHex } = buildBtcTx(30);
    const staleCkbVirtualResult = { ...ckbVirtualResult, needPaymasterCell: true };
    await transactionProcessor.enqueueTransaction({ txid, ckbVirtualResult: staleCkbVirtualResult });
    await saveSubmission(btcTxHex);
    const job = (await transactionProcessor.getTransactionRequest(txid))!;

    expect(await transactionProcessor.getCkbVirtualResult(job)).toEqual(ckbVirtualResult);

    // once applied, the job data is used
    await cradle.redis.hset(getSubmissionKey(txid), 'applied', '1');
    expect(await transactionProcessor.getCkbVirtualResult(job)).toEqual(staleCkbVirtualResult);
  });

  test('worker: should retry the failed job if the submission has not been applied', async () => {
    const { txid, btcTxHex } = buildBtcTx(31);
    await saveSubmission(btcTxHex);
    const job = {
      id: txid,
      data: { txid, ckbVirtualResult },
      getState: vi.fn().mockResolvedValue('failed'),
      retry: vi.fn(),
    } as unknown as Job<ITransactionRequest>;

    // the job failed on /ckb-tx data while the submission was being saved
    transactionProcessor['worker'].emit('failed', job, new Error('Invalid transaction'), 'active');

    await vi.waitFor(() => expect(job.retry).toHaveBeenCalledWith('failed'));
  });

  test('worker: should not retry the failed job if the submission has been applied', async () => {
    const { txid, btcTxHex } = buildBtcTx(32);
    await saveSubmission(btcTxHex);
    await cradle.redis.hset(getSubmissionKey(txid), 'applied', '1');
    const job = {
      id: txid,
      data: { txid, ckbVirtualResult },
      getState: vi.fn().mockResolvedValue('failed'),
      retry: vi.fn(),
    } as unknown as Job<ITransactionRequest>;
    const retryIfSubmissionUnused = vi.spyOn(
      transactionProcessor as unknown as { retryIfSubmissionUnused: () => Promise<void> },
      'retryIfSubmissionUnused',
    );

    transactionProcessor['worker'].emit('failed', job, new Error('Conflicted'), 'active');

    await vi.waitFor(() => expect(retryIfSubmissionUnused).toHaveBeenCalled());
    await retryIfSubmissionUnused.mock.results[0].value;
    expect(job.retry).not.toHaveBeenCalled();
  });

  test('submitTransaction: should limit the signed transactions submitted concurrently', async () => {
    for (let i = 0; i < 4; i++) {
      await saveSubmission(buildBtcTx(21, { witness: `0${i}` }).btcTxHex);
    }
    vi.spyOn(cradle.bitcoin, 'postTx').mockRejectedValue(
      createBitcoinClientAPIError('Connection error', HttpStatusCode.ServiceUnavailable),
    );
    vi.spyOn(cradle.bitcoin, 'getTx').mockRejectedValue(
      createBitcoinClientAPIError('Connection error', HttpStatusCode.ServiceUnavailable),
    );

    const results = await Promise.allSettled([
      submit(buildBtcTx(21, { witness: '04' }).btcTxHex),
      submit(buildBtcTx(21, { witness: '05' }).btcTxHex),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const submission = await transactionProcessor.getSubmission(buildBtcTx(21).txid);
    expect(submission?.btcTxHexes).toHaveLength(5);
  });

  test('submitTransaction: should limit the signed transactions with the same txid', async () => {
    for (let i = 0; i < 5; i++) {
      await saveSubmission(buildBtcTx(16, { witness: `0${i}` }).btcTxHex);
    }

    await expect(submit(buildBtcTx(16, { witness: '05' }).btcTxHex)).rejects.toMatchObject({
      statusCode: HttpStatusCode.Conflict,
    });
  });

  test('process: should rebroadcast the submitted transaction when it is not found', async () => {
    const { txid, btcTxHex } = buildBtcTx(9);
    await saveSubmission(btcTxHex);
    vi.spyOn(cradle.bitcoin, 'getTx').mockRejectedValue(
      createBitcoinClientAPIError('Transaction not found', HttpStatusCode.NotFound),
    );
    vi.spyOn(cradle.bitcoin, 'getTxOutspend').mockResolvedValue({ spent: false });
    const postTx = vi.spyOn(cradle.bitcoin, 'postTx').mockResolvedValue(txid);
    mockRecordJobError();
    const job = mockJob(txid);

    await expect(transactionProcessor.process(job)).rejects.toThrow(DelayedError);
    expect(postTx).toHaveBeenCalledWith({ txhex: btcTxHex });
    expect(job.moveToDelayed).toHaveBeenCalled();
  });

  test('process: should rebroadcast the submitted transaction after the not found tolerance time', async () => {
    const { txid, btcTxHex } = buildBtcTx(10);
    await saveSubmission(btcTxHex);
    vi.spyOn(cradle.bitcoin, 'getTx').mockRejectedValue(
      createBitcoinClientAPIError('Transaction not found', HttpStatusCode.NotFound),
    );
    vi.spyOn(cradle.bitcoin, 'getTxOutspend').mockResolvedValue({ spent: false });
    const postTx = vi.spyOn(cradle.bitcoin, 'postTx').mockResolvedValue(txid);
    mockRecordJobError();
    // e.g. a week of downtime
    await ageSubmission(txid, 7 * 24 * 60 * 60 * 1000);
    const job = mockJob(txid);

    const now = Date.now();
    await expect(transactionProcessor.process(job)).rejects.toThrow(DelayedError);
    expect(postTx).toHaveBeenCalledWith({ txhex: btcTxHex });
    const [delayedTimestamp] = vi.mocked(job.moveToDelayed).mock.calls[0];
    expect(delayedTimestamp).toBeGreaterThanOrEqual(now + 60 * 60 * 1000);
  });

  test.each([HttpStatusCode.ServiceUnavailable, HttpStatusCode.TooManyRequests])(
    'process: should delay the submitted transaction without more requests when the Bitcoin API returns %d',
    async (statusCode) => {
      const { txid, btcTxHex } = buildBtcTx(17);
      await saveSubmission(btcTxHex);
      // past the max recovery time, it still shouldn't fail
      await ageSubmission(txid, 15 * 24 * 60 * 60 * 1000);
      vi.spyOn(cradle.bitcoin, 'getTx').mockRejectedValue(createBitcoinClientAPIError('Unavailable', statusCode));
      const getTxOutspend = vi.spyOn(cradle.bitcoin, 'getTxOutspend');
      const postTx = vi.spyOn(cradle.bitcoin, 'postTx');
      mockRecordJobError();
      const job = mockJob(txid);

      await expect(transactionProcessor.process(job)).rejects.toThrow(DelayedError);
      expect(getTxOutspend).not.toHaveBeenCalled();
      expect(postTx).not.toHaveBeenCalled();
    },
  );

  test('process: should fail the job when the submitted transaction is still rejected after the max recovery time', async () => {
    const { txid, btcTxHex } = buildBtcTx(33);
    await saveSubmission(btcTxHex);
    await ageSubmission(txid, 15 * 24 * 60 * 60 * 1000);
    vi.spyOn(cradle.bitcoin, 'getTx').mockRejectedValue(
      createBitcoinClientAPIError('Transaction not found', HttpStatusCode.NotFound),
    );
    // the parent was replaced, so the input doesn't exist
    vi.spyOn(cradle.bitcoin, 'getTxOutspend').mockRejectedValue(
      createBitcoinClientAPIError('Transaction not found', HttpStatusCode.NotFound),
    );
    vi.spyOn(cradle.bitcoin, 'postTx').mockRejectedValue(
      createBitcoinClientAPIError(
        'sendrawtransaction RPC error: {"code":-25,"message":"bad-txns-inputs-missingorspent"}',
        HttpStatusCode.BadRequest,
      ),
    );
    mockRecordJobError();
    const job = mockJob(txid);

    await expect(transactionProcessor.process(job)).rejects.toThrow(UnrecoverableError);
  });

  test('process: should not give up if the transaction shows up after the rejection', async () => {
    const { txid, btcTxHex } = buildBtcTx(36);
    await saveSubmission(btcTxHex);
    await ageSubmission(txid, 15 * 24 * 60 * 60 * 1000);
    // the first lookup is stale, the transaction has confirmed by the time it's rebroadcast
    vi.spyOn(cradle.bitcoin, 'getTx')
      .mockRejectedValueOnce(createBitcoinClientAPIError('Transaction not found', HttpStatusCode.NotFound))
      .mockResolvedValueOnce({ txid } as unknown as Transaction);
    vi.spyOn(cradle.bitcoin, 'getTxOutspend').mockResolvedValue({ spent: false });
    vi.spyOn(cradle.bitcoin, 'postTx').mockRejectedValue(
      createBitcoinClientAPIError(
        'sendrawtransaction RPC error: {"code":-27,"message":"Transaction already in block chain"}',
        HttpStatusCode.BadRequest,
      ),
    );
    mockRecordJobError();
    const job = mockJob(txid);

    const now = Date.now();
    await expect(transactionProcessor.process(job)).rejects.toThrow(DelayedError);
    const [delayedTimestamp] = vi.mocked(job.moveToDelayed).mock.calls[0];
    expect(delayedTimestamp).toBeLessThan(now + 60 * 60 * 1000);
  });

  test('process: should not give up when the lookup after the rejection fails', async () => {
    const { txid, btcTxHex } = buildBtcTx(39);
    await saveSubmission(btcTxHex);
    await ageSubmission(txid, 15 * 24 * 60 * 60 * 1000);
    vi.spyOn(cradle.bitcoin, 'getTx')
      .mockRejectedValueOnce(createBitcoinClientAPIError('Transaction not found', HttpStatusCode.NotFound))
      .mockRejectedValueOnce(createBitcoinClientAPIError('Service Unavailable', HttpStatusCode.ServiceUnavailable));
    vi.spyOn(cradle.bitcoin, 'getTxOutspend').mockResolvedValue({ spent: false });
    vi.spyOn(cradle.bitcoin, 'postTx').mockRejectedValue(
      createBitcoinClientAPIError(
        'sendrawtransaction RPC error: {"code":-27,"message":"Transaction already in block chain"}',
        HttpStatusCode.BadRequest,
      ),
    );
    mockRecordJobError();

    await expect(transactionProcessor.process(mockJob(txid))).rejects.toThrow(DelayedError);
  });

  test('process: should not retry a conflicted job because of an earlier checkedSeq', async () => {
    const old = buildBtcTx(40, { witness: 'aa' });
    const resigned = buildBtcTx(40, { witness: 'bb' });
    await saveSubmission(old.btcTxHex);
    await saveSubmission(resigned.btcTxHex);
    // left by an earlier run that gave up on the old version, then retried for the new one
    await cradle.redis.hset(getSubmissionKey(old.txid), 'applied', '1', 'checkedSeq', '1');
    vi.spyOn(cradle.bitcoin, 'getTx').mockRejectedValue(
      createBitcoinClientAPIError('Transaction not found', HttpStatusCode.NotFound),
    );
    vi.spyOn(cradle.bitcoin, 'getTxOutspend').mockResolvedValue({
      spent: true,
      txid: 'ff'.repeat(32),
      vout: 0,
      status: { confirmed: true, block_height: 100 },
    } as unknown as Awaited<ReturnType<typeof cradle.bitcoin.getTxOutspend>>);
    mockRecordJobError();
    await expect(transactionProcessor.process(mockJob(old.txid))).rejects.toThrow(UnrecoverableError);

    const failedJob = {
      id: old.txid,
      data: { txid: old.txid, ckbVirtualResult },
      getState: vi.fn().mockResolvedValue('failed'),
      retry: vi.fn(),
    } as unknown as Job<ITransactionRequest>;
    const retryIfSubmissionUnused = vi.spyOn(
      transactionProcessor as unknown as { retryIfSubmissionUnused: () => Promise<void> },
      'retryIfSubmissionUnused',
    );
    transactionProcessor['worker'].emit('failed', failedJob, new Error('Conflicted'), 'active');

    await vi.waitFor(() => expect(retryIfSubmissionUnused).toHaveBeenCalled());
    await retryIfSubmissionUnused.mock.results[0].value;
    expect(failedJob.retry).not.toHaveBeenCalled();
  });

  test('process: should retry the job given up while a new signed version was submitted', async () => {
    const old = buildBtcTx(37, { witness: 'aa' });
    const resigned = buildBtcTx(37, { witness: 'bb' });
    await saveSubmission(old.btcTxHex);
    await ageSubmission(old.txid, 15 * 24 * 60 * 60 * 1000);
    await cradle.redis.hset(getSubmissionKey(old.txid), 'applied', '1');
    vi.spyOn(cradle.bitcoin, 'getTx').mockRejectedValue(
      createBitcoinClientAPIError('Transaction not found', HttpStatusCode.NotFound),
    );
    vi.spyOn(cradle.bitcoin, 'getTxOutspend').mockResolvedValue({ spent: false });
    vi.spyOn(cradle.bitcoin, 'postTx').mockImplementation(async () => {
      // /submit saves a re-signed version while the worker is rebroadcasting the old one
      await transactionProcessor['saveSubmission'](old.txid, resigned.wtxid, resigned.btcTxHex, ckbVirtualResult);
      throw createBitcoinClientAPIError(
        'sendrawtransaction RPC error: {"code":-26,"message":"mandatory-script-verify-flag-failed"}',
        HttpStatusCode.BadRequest,
      );
    });
    mockRecordJobError();
    await expect(transactionProcessor.process(mockJob(old.txid))).rejects.toThrow(UnrecoverableError);

    const failedJob = {
      id: old.txid,
      data: { txid: old.txid, ckbVirtualResult },
      getState: vi.fn().mockResolvedValue('failed'),
      retry: vi.fn(),
    } as unknown as Job<ITransactionRequest>;
    transactionProcessor['worker'].emit('failed', failedJob, new Error('Rejected'), 'active');

    await vi.waitFor(() => expect(failedJob.retry).toHaveBeenCalledWith('failed'));
  });

  test('process: should not retry the job given up after trying every signed version', async () => {
    const { txid, btcTxHex } = buildBtcTx(38);
    await saveSubmission(btcTxHex);
    await ageSubmission(txid, 15 * 24 * 60 * 60 * 1000);
    await cradle.redis.hset(getSubmissionKey(txid), 'applied', '1');
    vi.spyOn(cradle.bitcoin, 'getTx').mockRejectedValue(
      createBitcoinClientAPIError('Transaction not found', HttpStatusCode.NotFound),
    );
    vi.spyOn(cradle.bitcoin, 'getTxOutspend').mockResolvedValue({ spent: false });
    vi.spyOn(cradle.bitcoin, 'postTx').mockRejectedValue(
      createBitcoinClientAPIError('Rejected', HttpStatusCode.BadRequest),
    );
    mockRecordJobError();
    await expect(transactionProcessor.process(mockJob(txid))).rejects.toThrow(UnrecoverableError);

    const failedJob = {
      id: txid,
      data: { txid, ckbVirtualResult },
      getState: vi.fn().mockResolvedValue('failed'),
      retry: vi.fn(),
    } as unknown as Job<ITransactionRequest>;
    const retryIfSubmissionUnused = vi.spyOn(
      transactionProcessor as unknown as { retryIfSubmissionUnused: () => Promise<void> },
      'retryIfSubmissionUnused',
    );
    transactionProcessor['worker'].emit('failed', failedJob, new Error('Rejected'), 'active');

    await vi.waitFor(() => expect(retryIfSubmissionUnused).toHaveBeenCalled());
    await retryIfSubmissionUnused.mock.results[0].value;
    expect(failedJob.retry).not.toHaveBeenCalled();
  });

  test.each([
    ['rejected within the max recovery time', 7, HttpStatusCode.BadRequest],
    ['rate limited after the max recovery time', 15, HttpStatusCode.TooManyRequests],
    ['unavailable after the max recovery time', 15, HttpStatusCode.ServiceUnavailable],
  ])('process: should keep rebroadcasting the submitted transaction %s', async (_, ageInDays, statusCode) => {
    const { txid, btcTxHex } = buildBtcTx(34);
    await saveSubmission(btcTxHex);
    await ageSubmission(txid, ageInDays * 24 * 60 * 60 * 1000);
    vi.spyOn(cradle.bitcoin, 'getTx').mockRejectedValue(
      createBitcoinClientAPIError('Transaction not found', HttpStatusCode.NotFound),
    );
    vi.spyOn(cradle.bitcoin, 'getTxOutspend').mockResolvedValue({ spent: false });
    vi.spyOn(cradle.bitcoin, 'postTx').mockRejectedValue(createBitcoinClientAPIError('Rejected', statusCode));
    mockRecordJobError();
    const job = mockJob(txid);

    await expect(transactionProcessor.process(job)).rejects.toThrow(DelayedError);
  });

  test('process: should rebroadcast the re-signed transaction when the first one is invalid', async () => {
    const invalid = buildBtcTx(18, { witness: 'aa' });
    const resigned = buildBtcTx(18, { witness: 'bb' });
    await saveSubmission(invalid.btcTxHex);
    await saveSubmission(resigned.btcTxHex);
    vi.spyOn(cradle.bitcoin, 'getTx').mockRejectedValue(
      createBitcoinClientAPIError('Transaction not found', HttpStatusCode.NotFound),
    );
    vi.spyOn(cradle.bitcoin, 'getTxOutspend').mockResolvedValue({ spent: false });
    const postTx = vi.spyOn(cradle.bitcoin, 'postTx').mockImplementation(async ({ txhex }) => {
      if (txhex === invalid.btcTxHex) {
        throw createBitcoinClientAPIError(
          'sendrawtransaction RPC error: {"code":-26,"message":"mandatory-script-verify-flag-failed"}',
          HttpStatusCode.BadRequest,
        );
      }
      return invalid.txid;
    });
    mockRecordJobError();
    const job = mockJob(invalid.txid);

    await expect(transactionProcessor.process(job)).rejects.toThrow(DelayedError);
    // the newest version goes first and succeeds
    expect(postTx).toHaveBeenCalledTimes(1);
    expect(postTx).toHaveBeenCalledWith({ txhex: resigned.btcTxHex });
  });

  test('process: should apply the submission to the valid job data created by /ckb-tx', async () => {
    const { txid, btcTxHex, opReturnScript } = buildBtcTx(19);
    const submitted = { ...ckbVirtualResult, needPaymasterCell: true };
    await saveSubmission(btcTxHex, submitted);
    mockUnconfirmedBtcTx(txid, opReturnScript);
    mockRecordJobError();
    // same commitment, different needPaymasterCell
    const job = mockJob(txid, { ckbVirtualResult: { ...ckbVirtualResult, needPaymasterCell: false } });

    // passes with the submission's data, then waits for confirmation
    await expect(transactionProcessor.process(job)).rejects.toThrow(DelayedError);
    expect(job.updateData).toHaveBeenCalledWith({ txid, ckbVirtualResult: submitted });
  });

  test('process: should apply the submission before verifying the job data with invalid lock args', async () => {
    const { txid, btcTxHex, opReturnScript } = buildBtcTx(22);
    await saveSubmission(btcTxHex);
    mockUnconfirmedBtcTx(txid, opReturnScript);
    mockRecordJobError();
    // /ckb-tx data with RGB++ lock args that can't be unpacked
    const invalidLock = { ...genRgbppLockScript(buildPreLockArgs(1), false), args: '0x01' };
    const job = mockJob(txid, {
      ckbVirtualResult: {
        ...ckbVirtualResult,
        ckbRawTx: {
          ...ckbVirtualResult.ckbRawTx,
          outputs: [{ capacity: '0x0', lock: invalidLock }] as OutputCell[],
          outputsData: ['0x'],
        },
      },
    });

    await expect(transactionProcessor.process(job)).rejects.toThrow(DelayedError);
    expect(job.updateData).toHaveBeenCalledWith({ txid, ckbVirtualResult });
  });

  test('process: should keep the job data changed by the worker after the submission is applied', async () => {
    const { txid, btcTxHex, opReturnScript } = buildBtcTx(23);
    await saveSubmission(btcTxHex);
    mockUnconfirmedBtcTx(txid, opReturnScript);
    mockRecordJobError();
    const job = mockJob(txid);
    await expect(transactionProcessor.process(job)).rejects.toThrow(DelayedError);

    // what fixPoolRejectedTransactionByMinFeeRate does
    job.data = {
      txid,
      ckbVirtualResult: {
        ...ckbVirtualResult,
        ckbRawTx: {
          ...ckbVirtualResult.ckbRawTx,
          cellDeps: [{ outPoint: { txHash: `0x${'11'.repeat(32)}`, index: '0x0' }, depType: 'depGroup' }],
        },
        needPaymasterCell: true,
      },
    };
    await expect(transactionProcessor.process(job)).rejects.toThrow(DelayedError);

    expect(job.updateData).not.toHaveBeenCalled();
    expect(job.data.ckbVirtualResult.needPaymasterCell).toBe(true);
  });

  test('process: should fail the job when the submitted transaction is conflicted', async () => {
    const { txid, btcTxHex, prevTxid } = buildBtcTx(11);
    await saveSubmission(btcTxHex);
    vi.spyOn(cradle.bitcoin, 'getTx').mockRejectedValue(
      createBitcoinClientAPIError('Transaction not found', HttpStatusCode.NotFound),
    );
    const getTxOutspend = vi.spyOn(cradle.bitcoin, 'getTxOutspend').mockResolvedValue({
      spent: true,
      txid: 'ff'.repeat(32),
      vout: 0,
      status: { confirmed: true, block_height: 100 },
    } as unknown as Awaited<ReturnType<typeof cradle.bitcoin.getTxOutspend>>);
    const postTx = vi.spyOn(cradle.bitcoin, 'postTx');
    mockRecordJobError();
    const job = mockJob(txid);

    await expect(transactionProcessor.process(job)).rejects.toThrow(UnrecoverableError);
    expect(getTxOutspend).toHaveBeenCalledWith({ txid: prevTxid, vout: 0 });
    expect(postTx).not.toHaveBeenCalled();
  });

  test('process: should not rebroadcast when the transaction is not submitted', async () => {
    const { txid } = buildBtcTx(12);
    vi.spyOn(cradle.bitcoin, 'getTx').mockRejectedValue(
      createBitcoinClientAPIError('Transaction not found', HttpStatusCode.NotFound),
    );
    const postTx = vi.spyOn(cradle.bitcoin, 'postTx');
    mockRecordJobError();
    const job = mockJob(txid);

    await expect(transactionProcessor.process(job)).rejects.toThrow(DelayedError);
    expect(postTx).not.toHaveBeenCalled();
  });

  test('process: should not keep retrying the Bitcoin API errors when the transaction is not submitted', async () => {
    const { txid } = buildBtcTx(20);
    vi.spyOn(cradle.bitcoin, 'getTx').mockRejectedValue(
      createBitcoinClientAPIError('Service Unavailable', HttpStatusCode.ServiceUnavailable),
    );
    vi.spyOn(
      transactionProcessor as unknown as { captureJobExceptionToSentryScope: () => void },
      'captureJobExceptionToSentryScope',
    ).mockReturnValue();
    mockRecordJobError();
    const job = mockJob(txid);

    await expect(transactionProcessor.process(job)).rejects.toThrow(BitcoinClientAPIError);
  });
});
