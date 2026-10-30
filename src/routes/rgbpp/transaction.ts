import { FastifyPluginCallback, FastifyRequest } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { Server } from 'http';
import z from 'zod';
import { CKBVirtualResult } from './types';
import { Job } from 'bullmq';
import { CUSTOM_HEADERS } from '../../constants';
import { JwtPayload } from '../../plugins/jwt';
import { env } from '../../env';

function getJwtPayload(request: FastifyRequest): JwtPayload {
  // Development environment: use mock JWT payload
  if (env.NODE_ENV === 'development') {
    return {
      sub: 'dev-app',
      aud: 'dev-rgbpp',
      jti: 'dev-token-id',
    };
  }
  // Production environment: use real JWT from request
  return request.user as JwtPayload;
}

const transactionRoute: FastifyPluginCallback<Record<never, never>, Server, ZodTypeProvider> = (fastify, _, done) => {
  const ckbVirtualResultBody = CKBVirtualResult.or(z.string()).transform((value) => {
    if (typeof value === 'string') {
      value = JSON.parse(value);
    }
    const parsed = CKBVirtualResult.safeParse(value);
    if (!parsed.success) {
      throw fastify.httpErrors.badRequest(`Invalid CKB virtual result: ${JSON.stringify(parsed.error.flatten())}`);
    }
    return parsed.data;
  });

  fastify.post(
    '/ckb-tx',
    {
      schema: {
        description:
          'Submit a RGB++ CKB transaction. Note: When including multiple assets, especially Spore, in a single transaction, please evaluate and ensure the final CKB transaction size does not exceed 512,000 bytes, otherwise the CKB node will reject it and permanently prevent RGB++ assets from being unlocked.',
        tags: ['RGB++'],
        body: z.object({
          btc_txid: z.string(),
          ckb_virtual_result: ckbVirtualResultBody,
        }),
        response: {
          200: z.object({
            state: z.string().describe('The state of the transaction, waiting by default'),
          }),
        },
      },
    },
    async (request, reply) => {
      const { btc_txid, ckb_virtual_result } = request.body;
      const jwt = getJwtPayload(request);

      const job: Job = await fastify.transactionProcessor.enqueueTransaction({
        txid: btc_txid,
        ckbVirtualResult: ckb_virtual_result,
        context: { jwt },
      });
      const state = await job.getState();
      reply.send({ state });
    },
  );

  fastify.post(
    '/submit',
    {
      schema: {
        description: `
          Submit a signed RGB++ BTC transaction together with its CKB virtual transaction.

          The service checks the OP_RETURN commitment, saves the request under the BTC txid, then broadcasts.
          If the broadcast fails or the transaction goes missing, it keeps rebroadcasting until the transaction
          is confirmed, an input is spent by another confirmed transaction, or it's still rejected after 14 days.
          A failed request with the same txid is resumed, unless its BTC transaction is conflicted.

          broadcast_status:
          * sent: broadcast, or already in the mempool or a block.
          * pending: outcome unknown (see broadcast_error), the service will retry.

          Retrying the same request is safe. A re-signed transaction (same txid, different witness) can be
          submitted again, up to 5 versions are kept and retried newest first. ckb_virtual_result must match
          the first request. Track the state with /rgbpp/v1/transaction/:btc_txid/job.

          Note: When including multiple assets, especially Spore, in a single transaction, please evaluate and ensure the final CKB transaction size does not exceed 512,000 bytes, otherwise the CKB node will reject it and permanently prevent RGB++ assets from being unlocked.
        `,
        tags: ['RGB++'],
        body: z.object({
          btc_tx_hex: z
            .string()
            .regex(/^([0-9a-fA-F]{2})+$/, 'should be an even-length hex string')
            .describe('The signed BTC transaction hex'),
          ckb_virtual_result: ckbVirtualResultBody,
        }),
        response: {
          200: z.object({
            btc_txid: z.string().describe('The BTC transaction id'),
            state: z.string().describe('The state of the transaction, delayed by default'),
            broadcast_status: z.enum(['sent', 'pending']).describe('Whether the BTC transaction has been broadcast'),
            broadcast_error: z
              .string()
              .optional()
              .describe('The broadcast error, only when broadcast_status is pending'),
          }),
        },
      },
    },
    async (request) => {
      const { btc_tx_hex, ckb_virtual_result } = request.body;
      const jwt = getJwtPayload(request);

      const { job, broadcastError } = await fastify.transactionProcessor.submitTransaction({
        btcTxHex: btc_tx_hex,
        ckbVirtualResult: ckb_virtual_result,
        context: { jwt },
      });
      const state = await job.getState();
      return {
        btc_txid: job.data.txid,
        state,
        // an empty error still means the outcome is unknown
        broadcast_status: broadcastError === undefined ? ('sent' as const) : ('pending' as const),
        broadcast_error: broadcastError,
      };
    },
  );

  fastify.get(
    '/:btc_txid',
    {
      schema: {
        deprecated: true,
        description: 'Use /rgbpp/v2/transaction/:btc_txid instead. Get the CKB transaction hash by BTC txid.',
        tags: ['RGB++'],
        params: z.object({
          btc_txid: z.string().length(64, 'should be a 64-character hex string'),
        }),
        response: {
          200: z.object({
            txhash: z.string().describe('The CKB transaction hash'),
          }),
        },
      },
    },
    async (request, reply) => {
      const { btc_txid } = request.params;
      // get the transaction hash from the job if it exists
      const job = await fastify.transactionProcessor.getTransactionRequest(btc_txid);
      if (job?.returnvalue) {
        return { txhash: job.returnvalue };
      }

      const btcTx = await fastify.bitcoin.getTx({ txid: btc_txid });
      const rgbppLockTx = await fastify.rgbppCollector.queryRgbppLockTxByBtcTx(btcTx);
      if (rgbppLockTx) {
        reply.header(CUSTOM_HEADERS.ResponseCacheable, 'true');
        return { txhash: rgbppLockTx.txHash };
      }
      const btcTimeLockTx = await fastify.rgbppCollector.queryBtcTimeLockTxByBtcTx(btcTx);
      if (btcTimeLockTx) {
        reply.header(CUSTOM_HEADERS.ResponseCacheable, 'true');
        return { txhash: btcTimeLockTx.transaction.hash };
      }

      reply.status(404);
    },
  );

  const jobInfoSchema = z.object({
    state: z.string().describe('The state of the transaction'),
    attempts: z.number().describe('The number of processing attempts made'),
    failedReason: z.string().optional().describe('The reason why the transaction failed'),
    lastError: z
      .object({
        attempt: z.number().describe('The attempt number when this error occurred'),
        error: z.string().describe('The error message'),
        timestamp: z.number().describe('The timestamp when this error occurred'),
      })
      .optional()
      .describe('The latest error encountered during processing (for delayed jobs, this explains the delay reason)'),
    data: z
      .object({
        txid: z.string(),
        ckbVirtualResult: CKBVirtualResult,
      })
      .describe('The data of the transaction')
      .optional(),
  });

  fastify.get(
    '/:btc_txid/job',
    {
      schema: {
        description: `
          Get the job info of a transaction by BTC txid.

          The state of the transaction can be one of the following:
          * completed: The CKB transaction has been sent and confirmed.
          * failed: Something went wrong during the process, and it has failed.
          * delayed: The transaction has not been confirmed yet and is waiting for confirmation.
          * active: The transaction is currently being processed.
          * waiting: The transaction is pending and is waiting to be processed.
          
          The response now includes the latest error information:
          * lastError: The most recent error encountered during processing, with attempt number and timestamp. For delayed jobs, this explains why the job is delayed.
        `,
        tags: ['RGB++'],
        params: z.object({
          btc_txid: z.string().length(64, 'should be a 64-character hex string'),
        }),
        querystring: z.object({
          with_data: z.enum(['true', 'false']).default('false'),
        }),
        response: {
          200: jobInfoSchema,
        },
      },
    },
    async (request, reply) => {
      const { btc_txid } = request.params;
      const { with_data } = request.query;
      const job = await fastify.transactionProcessor.getTransactionRequest(btc_txid);
      if (!job) {
        reply.status(404);
        return;
      }
      const state = await job.getState();

      // Get error info to calculate actual processing attempts and latest error
      const { attemptCount, lastError } = await fastify.transactionProcessor.getJobErrorInfo(job);

      const jobInfo: z.infer<typeof jobInfoSchema> = {
        state,
        attempts: attemptCount,
      };

      if (with_data === 'true') {
        jobInfo.data = {
          txid: job.data.txid,
          ckbVirtualResult: await fastify.transactionProcessor.getCkbVirtualResult(job),
        };
      }

      // Add error information for failed jobs
      if (state === 'failed') {
        jobInfo.failedReason = job.failedReason;
      }

      // Add latest error information
      if (lastError) {
        jobInfo.lastError = lastError;
      }
      return jobInfo;
    },
  );

  fastify.post(
    '/retry',
    {
      schema: {
        description: 'Retry a failed transaction by BTC txid, only failed transactions can be retried.',
        tags: ['RGB++'],
        body: z.object({
          btc_txid: z.string(),
        }),
        response: {
          200: z.object({
            success: z.boolean().describe('Whether the transaction has been retried successfully'),
            state: z.string().describe('The state of the transaction'),
          }),
        },
      },
    },
    async (request, reply) => {
      const { btc_txid } = request.body;
      const job = await fastify.transactionProcessor.getTransactionRequest(btc_txid);
      if (!job) {
        reply.status(404);
        return;
      }
      const state = await job.getState();
      if (state === 'failed') {
        await job.retry('failed');
        const newState = await job.getState();
        return {
          success: true,
          state: newState,
        };
      }
      return {
        success: false,
        state,
      };
    },
  );

  done();
};

export default transactionRoute;
