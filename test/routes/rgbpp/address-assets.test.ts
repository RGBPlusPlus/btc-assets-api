import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { expect, it, vi } from 'vitest';
import type { Cradle } from '../../../src/container';
import addressRoutes from '../../../src/routes/rgbpp/address';
import * as typeScriptUtils from '../../../src/utils/typescript';

const address = 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn';
const script = { codeHash: '0x' + '01'.repeat(32), args: '0xabcd', hashType: 'type' as const };
const cell = { cellOutput: { capacity: '0x1', lock: script, type: script }, data: '0x' };

it('validates and parses the asset filter before reading UTXOs or cells', async () => {
  const app = Fastify();
  const parseFilter = vi.spyOn(typeScriptUtils, 'getTypeScript');
  const getUtxosByAddress = vi.fn().mockResolvedValue([]);
  const getRgbppUtxoCellsPairs = vi.fn().mockResolvedValue([{ cells: [cell] }]);
  app.decorate('container', { resolve: () => ({}) } as unknown as typeof app.container);
  app.decorate('utxoSyncer', { getUtxosByAddress } as unknown as Cradle['utxoSyncer']);
  app.decorate('rgbppCollector', { getRgbppUtxoCellsPairs } as unknown as Cradle['rgbppCollector']);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(addressRoutes, { prefix: '/rgbpp/v1/address' });

  const url = '/rgbpp/v1/address/' + address + '/assets';
  const filter = encodeURIComponent(JSON.stringify(script));
  try {
    const invalidCacheFlag = await app.inject({ url: url + '?no_cache=not-a-boolean&type_script=' + filter });
    expect(invalidCacheFlag.statusCode).toBe(400);
    expect(getUtxosByAddress).not.toHaveBeenCalled();
    expect(parseFilter).not.toHaveBeenCalled();

    const response = await app.inject({ url: url + '?no_cache=true&type_script=' + filter });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ ...cell, typeHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) }]);
    expect(parseFilter.mock.invocationCallOrder[0]).toBeLessThan(getUtxosByAddress.mock.invocationCallOrder[0]);
    expect(getUtxosByAddress).toHaveBeenCalledWith(address, true);
    expect(getRgbppUtxoCellsPairs).toHaveBeenCalledWith(address, [], true);
  } finally {
    parseFilter.mockRestore();
    await app.close();
  }
});
