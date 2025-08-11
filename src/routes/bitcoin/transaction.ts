import { FastifyPluginCallback } from 'fastify';
import { Server } from 'http';
import { Transaction } from './types';
import { CUSTOM_HEADERS } from '../../constants';
import z from 'zod';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { TxOutspend } from '../../services/bitcoin/schema';

const transactionRoutes: FastifyPluginCallback<Record<never, never>, Server, ZodTypeProvider> = (fastify, _, done) => {
  fastify.post(
    '',
    {
      schema: {
        description: 'Send a raw transaction to the Bitcoin network',
        tags: ['Bitcoin'],
        body: z.object({
          txhex: z.string().describe('The raw transaction hex'),
        }),
        response: {
          200: z.object({
            txid: z.string(),
          }),
        },
      },
    },
    async (request) => {
      const { txhex } = request.body;
      const txid = await fastify.bitcoin.postTx({ txhex });
      return {
        txid,
      };
    },
  );

  fastify.get(
    '/:txid',
    {
      schema: {
        description: 'Get a transaction by its txid',
        tags: ['Bitcoin'],
        params: z.object({
          txid: z.string().length(64, 'should be a 64-character hex string').describe('The Bitcoin transaction id'),
        }),
        response: {
          200: Transaction,
        },
      },
    },
    async (request, reply) => {
      const { txid } = request.params;
      const transaction = await fastify.bitcoin.getTx({ txid });
      if (transaction.status.confirmed) {
        reply.header(CUSTOM_HEADERS.ResponseCacheable, 'true');
      }
      return transaction;
    },
  );

  fastify.get(
    '/:txid/hex',
    {
      schema: {
        description: 'Get a transaction hex by its txid',
        tags: ['Bitcoin'],
        params: z.object({
          txid: z.string().length(64, 'should be a 64-character hex string').describe('The Bitcoin transaction id'),
        }),
        response: {
          200: z.object({
            hex: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { txid } = request.params;
      const hex = await fastify.bitcoin.getTxHex({ txid });
      reply.header(CUSTOM_HEADERS.ResponseCacheable, 'true');
      return { hex };
    },
  );

  fastify.get(
    '/:txid/outspend/:vout',
    {
      schema: {
        description: 'Get the spending status of a transaction output',
        tags: ['Bitcoin'],
        params: z.object({
          txid: z.string().length(64, 'should be a 64-character hex string').describe('The Bitcoin transaction id'),
          vout: z.string().min(1, 'cannot be empty').pipe(z.coerce.number().min(0, 'cannot be negative')),
        }),
        response: {
          200: TxOutspend,
        },
      },
    },
    async (request, reply) => {
      const { txid, vout } = request.params;
      const outspend = await fastify.bitcoin.getTxOutspend({ txid, vout });
      if (outspend.spent || outspend.status?.confirmed) {
        reply.header(CUSTOM_HEADERS.ResponseCacheable, 'true');
      }
      return outspend;
    },
  );

  done();
};

export default transactionRoutes;
