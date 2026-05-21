import { FastifyPluginCallback } from 'fastify';
import { Server } from 'http';
import validateBitcoinAddress from '../../utils/validators';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { IsomorphicTransaction, Script } from './types';
import { createGetIsomorphicTx } from './shared';
import z from 'zod';
import { isScriptEqual } from '@rgbpp-sdk/ckb';
import { Transaction as BTCTransaction } from '../bitcoin/types';
import { getTypeScript } from '../../utils/typescript';

const addressRoutesV2: FastifyPluginCallback<Record<never, never>, Server, ZodTypeProvider> = (fastify, _, done) => {
  fastify.addHook('preHandler', async (request) => {
    const { btc_address } = request.params as { btc_address: string };
    const valid = validateBitcoinAddress(btc_address);
    if (!valid) {
      throw fastify.httpErrors.badRequest('Invalid bitcoin address');
    }
  });

  // v2: include output-only rgbpp lock transactions
  const getIsomorphicTx = createGetIsomorphicTx(fastify, true);

  fastify.get(
    '/:btc_address/activity',
    {
      schema: {
        description: 'Get RGB++ activity by btc address, including output-only rgbpp lock transactions',
        tags: ['RGB++ V2'],
        params: z.object({
          btc_address: z.string(),
        }),
        querystring: z.object({
          type_script: Script.or(z.string())
            .describe(
              `
              type script to filter cells

              two ways to provide:
              - as a object: 'encodeURIComponent(JSON.stringify({"codeHash":"0x...", "args":"0x...", "hashType":"type"}))'
              - as a hex string: '0x...' (You can pack by @ckb-lumos/codec blockchain.Script.pack({ "codeHash": "0x...", ... }))
            `,
            )
            .optional(),
          rgbpp_only: z
            .enum(['true', 'false'])
            .default('false')
            .describe('Whether to get RGB++ only activity, default is false'),
          after_btc_txid: z.string().optional().describe('Get activity after this btc txid'),
        }),
        response: {
          200: z.object({
            address: z.string(),
            txs: z.array(
              z
                .object({
                  btcTx: BTCTransaction,
                })
                .and(
                  z.union([
                    z.object({
                      isRgbpp: z.literal(true),
                      isomorphicTx: IsomorphicTransaction,
                    }),
                    z.object({ isRgbpp: z.literal(false) }),
                  ]),
                ),
            ),
            cursor: z.string().optional(),
          }),
        },
      },
    },
    async (request) => {
      const { btc_address } = request.params;
      const { rgbpp_only, after_btc_txid } = request.query;
      const typeScript = getTypeScript(request.query.type_script);

      const btcTxs = await fastify.bitcoin.getAddressTxs({
        address: btc_address,
        after_txid: after_btc_txid,
      });

      let txs = await Promise.all(
        btcTxs.map(async (btcTx) => {
          const isomorphicTx = await getIsomorphicTx(btcTx);
          const isRgbpp = isomorphicTx.ckbVirtualTx || isomorphicTx.ckbTx;
          if (!isRgbpp) {
            return {
              btcTx,
              isRgbpp: false,
            } as const;
          }

          const inputs = isomorphicTx.ckbVirtualTx?.inputs || isomorphicTx.ckbTx?.inputs || [];
          const inputCells = await fastify.ckb.getInputCellsByOutPoint(inputs.map((input) => input.previousOutput!));
          const inputCellOutputs = inputCells.map((cell) => cell.cellOutput);

          const outputs = isomorphicTx.ckbVirtualTx?.outputs || isomorphicTx.ckbTx?.outputs || [];

          return {
            btcTx,
            isRgbpp: true,
            isomorphicTx: {
              ...isomorphicTx,
              inputs: inputCellOutputs,
              outputs,
            },
          } as const;
        }),
      );

      if (rgbpp_only === 'true') {
        txs = txs.filter((tx) => tx.isRgbpp);
      }

      if (typeScript) {
        txs = txs.filter((tx) => {
          if (!tx.isRgbpp) {
            return false;
          }
          const cells = [...tx.isomorphicTx.inputs, ...tx.isomorphicTx.outputs];
          const filteredCells = cells.filter((cell) => {
            if (!cell.type) return false;
            if (!typeScript.args) {
              const script = { ...cell.type, args: '' };
              return isScriptEqual(script, typeScript);
            }
            return isScriptEqual(cell.type, typeScript);
          });
          return filteredCells.length > 0;
        });
      }

      const cursor = btcTxs.length > 0 ? btcTxs[btcTxs.length - 1].txid : undefined;
      return {
        address: btc_address,
        txs,
        cursor,
      };
    },
  );

  done();
};

export default addressRoutesV2;
