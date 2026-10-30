import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { buildFastify } from '../../../src/app';
import { describe } from 'node:test';
import TransactionProcessor, { ITransactionRequest } from '../../../src/services/transaction';
import { CKBVirtualResult } from '../../../src/routes/rgbpp/types';
import { Job } from 'bullmq';
import { calculateCommitment } from '@rgbpp-sdk/ckb';
import { Transaction as BitcoinTransaction, payments } from 'bitcoinjs-lib';
import BitcoinClient from '../../../src/services/bitcoin';

let token: string;

describe('/rgbpp/v1/transaction', () => {
  beforeEach(async () => {
    const fastify = buildFastify();
    await fastify.ready();

    const response = await fastify.inject({
      method: 'POST',
      url: '/token/generate',
      payload: {
        app: 'test',
        domain: 'test.com',
      },
    });
    const data = response.json();
    token = data.token;

    await fastify.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mockCkbVirtualResult: CKBVirtualResult = {
    ckbRawTx: {
      version: '0x0',
      cellDeps: [
        {
          outPoint: {
            txHash: '0x04c5c3e69f1aa6ee27fb9de3d15a81704e387ab3b453965adbe0b6ca343c6f41',
            index: '0x0',
          },
          depType: 'code',
        },
        {
          outPoint: {
            txHash: '0xc07844ce21b38e4b071dd0e1ee3b0e27afd8d7532491327f39b786343f558ab7',
            index: '0x0',
          },
          depType: 'code',
        },
        {
          outPoint: {
            txHash: '0x04c5c3e69f1aa6ee27fb9de3d15a81704e387ab3b453965adbe0b6ca343c6f41',
            index: '0x1',
          },
          depType: 'code',
        },
      ],
      headerDeps: [],
      inputs: [
        {
          previousOutput: {
            txHash: '0x56756961892340bb675138fb4a4055a97b340179530cd9c508f601a821ce28b8',
            index: '0x0',
          },
          since: '0x0',
        },
      ],
      outputs: [
        {
          capacity: '0x5e9f5203e',
          lock: {
            codeHash: '0xbc6c568a1a0d0a09f6844dc9d74ddb4343c32143ff25f727c59edf4fb72d6936',
            args: '0x010000000000000000000000000000000000000000000000000000000000000000000000',
            hashType: 'type',
          },
          type: {
            codeHash: '0x50bd8d6680b8b9cf98b73f3c08faf8b2a21914311954118ad6609be6e78a1b95',
            args: '0x2ae639d6233f9b15545573b8e78f38ff7aa6c7bf8ef6460bf1f12d0a76c09c4e',
            hashType: 'data1',
          },
        },
      ],
      outputsData: ['0x00e87648170000000000000000000000'],
      witnesses: ['0xFF'],
    },
    commitment: '1f434e4bc1eb8ccb9ac37fd018dcb6989ac1a95ae340db96a030822bd2f268ed',
    needPaymasterCell: false,
    sumInputsCapacity: '0x5e9f52f1f',
  };

  test('Post transaction', async () => {
    const fastify = buildFastify();
    await fastify.ready();

    const response = await fastify.inject({
      method: 'POST',
      url: '/rgbpp/v1/transaction/ckb-tx',
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'https://test.com',
      },
      body: {
        btc_txid: '0662cbe5a6666f36d3c6c431e22ef5073acf059d4ea1c7cd8d158b4107ab0d68',
        ckb_virtual_result: mockCkbVirtualResult,
      },
    });

    expect(response.statusCode).toBe(200);

    await fastify.close();
  });

  test('Post transaction with ckb_virtual_result JSON string', async () => {
    const fastify = buildFastify();
    await fastify.ready();

    const response = await fastify.inject({
      method: 'POST',
      url: '/rgbpp/v1/transaction/ckb-tx',
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'https://test.com',
      },
      body: {
        btc_txid: '0662cbe5a6666f36d3c6c431e22ef5073acf059d4ea1c7cd8d158b4107ab0d68',
        ckb_virtual_result: JSON.stringify(mockCkbVirtualResult),
      },
    });

    expect(response.statusCode).toBe(200);

    await fastify.close();
  });

  test('Post transaction with Invalid ckb_virtual_result JSON string', async () => {
    const fastify = buildFastify();
    await fastify.ready();

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { commitment, ...incorrectCkbVirtualResult } = mockCkbVirtualResult;

    const response = await fastify.inject({
      method: 'POST',
      url: '/rgbpp/v1/transaction/ckb-tx',
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'https://test.com',
      },
      body: {
        btc_txid: '0662cbe5a6666f36d3c6c431e22ef5073acf059d4ea1c7cd8d158b4107ab0d69',
        ckb_virtual_result: JSON.stringify(incorrectCkbVirtualResult),
      },
    });
    const data = response.json();

    expect(response.statusCode).toBe(400);
    expect(data).toEqual({
      message: 'Invalid CKB virtual result: {"formErrors":[],"fieldErrors":{"commitment":["Required"]}}',
    });

    await fastify.close();
  });

  function buildBtcTx(commitment: string) {
    const tx = new BitcoinTransaction();
    tx.version = 2;
    tx.addInput(Buffer.alloc(32, 0xab), 0);
    tx.addOutput(Buffer.from(`0014${'00'.repeat(20)}`, 'hex'), 546);
    tx.addOutput(payments.embed({ data: [Buffer.from(commitment, 'hex')] }).output!, 0);
    return { txid: tx.getId(), btcTxHex: tx.toHex() };
  }

  test('Submit transaction', async () => {
    const fastify = buildFastify();
    await fastify.ready();

    const ckbVirtualResult = {
      ...mockCkbVirtualResult,
      commitment: calculateCommitment(mockCkbVirtualResult.ckbRawTx),
    };
    const { txid, btcTxHex } = buildBtcTx(ckbVirtualResult.commitment);
    const bitcoin: BitcoinClient = fastify.container.resolve('bitcoin');
    const postTx = vi.spyOn(bitcoin, 'postTx').mockResolvedValueOnce(txid);

    const response = await fastify.inject({
      method: 'POST',
      url: '/rgbpp/v1/transaction/submit',
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'https://test.com',
      },
      body: {
        btc_tx_hex: btcTxHex,
        ckb_virtual_result: ckbVirtualResult,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ btc_txid: txid, state: 'delayed', broadcast_status: 'sent' });
    expect(postTx).toHaveBeenCalledWith({ txhex: btcTxHex });

    await fastify.close();
  });

  test('Submit transaction with an empty broadcast error', async () => {
    const fastify = buildFastify();
    await fastify.ready();

    const ckbVirtualResult = {
      ...mockCkbVirtualResult,
      commitment: calculateCommitment(mockCkbVirtualResult.ckbRawTx),
    };
    const { txid, btcTxHex } = buildBtcTx(ckbVirtualResult.commitment);
    const transactionProcessor: TransactionProcessor = fastify.container.resolve('transactionProcessor');
    vi.spyOn(transactionProcessor, 'submitTransaction').mockResolvedValueOnce({
      job: {
        data: { txid, ckbVirtualResult },
        getState: vi.fn().mockResolvedValue('delayed'),
      } as unknown as Job<ITransactionRequest>,
      broadcastError: '',
    });

    const response = await fastify.inject({
      method: 'POST',
      url: '/rgbpp/v1/transaction/submit',
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'https://test.com',
      },
      body: {
        btc_tx_hex: btcTxHex,
        ckb_virtual_result: ckbVirtualResult,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      btc_txid: txid,
      state: 'delayed',
      broadcast_status: 'pending',
      broadcast_error: '',
    });

    await fastify.close();
  });

  test('Submit transaction with invalid btc_tx_hex', async () => {
    const fastify = buildFastify();
    await fastify.ready();

    const response = await fastify.inject({
      method: 'POST',
      url: '/rgbpp/v1/transaction/submit',
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'https://test.com',
      },
      body: {
        btc_tx_hex: 'not-a-hex-string',
        ckb_virtual_result: mockCkbVirtualResult,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ message: 'Invalid btc_tx_hex: should be an even-length hex string' });

    await fastify.close();
  });

  test('Submit transaction with odd-length btc_tx_hex', async () => {
    const fastify = buildFastify();
    await fastify.ready();

    const { btcTxHex } = buildBtcTx(calculateCommitment(mockCkbVirtualResult.ckbRawTx));
    const bitcoin: BitcoinClient = fastify.container.resolve('bitcoin');
    const postTx = vi.spyOn(bitcoin, 'postTx');

    const response = await fastify.inject({
      method: 'POST',
      url: '/rgbpp/v1/transaction/submit',
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'https://test.com',
      },
      body: {
        btc_tx_hex: `${btcTxHex}f`,
        ckb_virtual_result: mockCkbVirtualResult,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ message: 'Invalid btc_tx_hex: should be an even-length hex string' });
    expect(postTx).not.toHaveBeenCalled();

    await fastify.close();
  });

  test('Submit transaction with mismatched commitment', async () => {
    const fastify = buildFastify();
    await fastify.ready();

    const { txid, btcTxHex } = buildBtcTx('00'.repeat(32));
    const bitcoin: BitcoinClient = fastify.container.resolve('bitcoin');
    const postTx = vi.spyOn(bitcoin, 'postTx');

    const response = await fastify.inject({
      method: 'POST',
      url: '/rgbpp/v1/transaction/submit',
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'https://test.com',
      },
      body: {
        btc_tx_hex: btcTxHex,
        ckb_virtual_result: mockCkbVirtualResult,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      message: `Commitment mismatch between the Bitcoin transaction and the CKB virtual result: ${txid}`,
    });
    expect(postTx).not.toHaveBeenCalled();

    await fastify.close();
  });

  test('Get transaction job info with completed state', async () => {
    const fastify = buildFastify();
    await fastify.ready();

    const transactionProcessor: TransactionProcessor = fastify.container.resolve('transactionProcessor');

    vi.spyOn(transactionProcessor, 'getTransactionRequest').mockResolvedValue({
      getState: vi.fn().mockResolvedValue('completed'),
      attemptsMade: 1,
      data: {
        txid: 'ccee39f38e5ad162c21a44bc6add20577811f13e35575fcb9103ef725a73c79d',
        ckbVirtualResult: mockCkbVirtualResult,
      },
    } as unknown as Job<ITransactionRequest, unknown, string>);

    const response = await fastify.inject({
      method: 'GET',
      url: '/rgbpp/v1/transaction/ccee39f38e5ad162c21a44bc6add20577811f13e35575fcb9103ef725a73c79d/job',
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'https://test.com',
      },
    });
    const data = response.json();

    expect(response.statusCode).toBe(200);
    expect(data).toEqual({
      state: 'completed',
      attempts: 1,
    });

    await fastify.close();
  });

  test('Get transaction job info with failed state', async () => {
    const fastify = buildFastify();
    await fastify.ready();

    const transactionProcessor: TransactionProcessor = fastify.container.resolve('transactionProcessor');

    vi.spyOn(transactionProcessor, 'getTransactionRequest').mockResolvedValue({
      getState: vi.fn().mockResolvedValue('failed'),
      attemptsMade: 1,
      failedReason: 'Failed to send transaction',
      data: {
        txid: 'ccee39f38e5ad162c21a44bc6add20577811f13e35575fcb9103ef725a73c79d',
        ckbVirtualResult: mockCkbVirtualResult,
      },
    } as unknown as Job<ITransactionRequest, unknown, string>);

    const response = await fastify.inject({
      method: 'GET',
      url: '/rgbpp/v1/transaction/ccee39f38e5ad162c21a44bc6add20577811f13e35575fcb9103ef725a73c79d/job',
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'https://test.com',
      },
    });
    const data = response.json();

    expect(response.statusCode).toBe(200);
    expect(data).toEqual({
      state: 'failed',
      attempts: 1,
      failedReason: 'Failed to send transaction',
    });

    await fastify.close();
  });

  test('Get transaction job info with data', async () => {
    const fastify = buildFastify();
    await fastify.ready();

    const transactionProcessor: TransactionProcessor = fastify.container.resolve('transactionProcessor');

    vi.spyOn(transactionProcessor, 'getTransactionRequest').mockResolvedValue({
      getState: vi.fn().mockResolvedValue('completed'),
      attemptsMade: 1,
      data: {
        txid: 'ccee39f38e5ad162c21a44bc6add20577811f13e35575fcb9103ef725a73c79d',
        ckbVirtualResult: mockCkbVirtualResult,
      },
    } as unknown as Job<ITransactionRequest, unknown, string>);

    const response = await fastify.inject({
      method: 'GET',
      url: '/rgbpp/v1/transaction/ccee39f38e5ad162c21a44bc6add20577811f13e35575fcb9103ef725a73c79d/job?with_data=true',
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'https://test.com',
      },
    });
    const data = response.json();

    expect(response.statusCode).toBe(200);
    expect(data).toEqual({
      state: 'completed',
      attempts: 1,
      data: {
        txid: 'ccee39f38e5ad162c21a44bc6add20577811f13e35575fcb9103ef725a73c79d',
        ckbVirtualResult: mockCkbVirtualResult,
      },
    });

    await fastify.close();
  });
});
