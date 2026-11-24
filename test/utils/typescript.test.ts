import { blockchain } from '@ckb-lumos/base';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { getXudtTypeScript } from '@rgbpp-sdk/ckb';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import assetsRoute from '../../src/routes/rgbpp/assets';
import type CKBClient from '../../src/services/ckb';
import { getTypeScript } from '../../src/utils/typescript';

const script = { codeHash: '0x' + '01'.repeat(32), args: '0xabcd', hashType: 'type' as const };

describe('type_script query decoding', () => {
  it('preserves packed, JSON and object scripts and optional filters', () => {
    const packed = '0x' + Buffer.from(blockchain.Script.pack(script)).toString('hex');
    expect(getTypeScript(packed)).toEqual(script);
    expect(getTypeScript(encodeURIComponent(JSON.stringify(script)))).toEqual(script);
    expect(getTypeScript(script)).toEqual(script);
    expect(getTypeScript({ ...script, args: '0xABCD' })?.args).toBe('0xABCD');
    expect(getTypeScript({ ...script, args: '' })?.args).toBe('');
    expect(getTypeScript(undefined)).toBeUndefined();
  });

  it.each([
    '0xzz',
    '0x01',
    '%invalid',
    'null',
    JSON.stringify({ ...script, args: '0x0' }),
    JSON.stringify({ ...script, args: '0Xabcd' }),
    JSON.stringify({ ...script, codeHash: script.codeHash.replace('0x', '0X') }),
  ])('reports malformed query input as HTTP 400 (%s)', async (type_script) => {
    const app = Fastify();
    app.get<{ Querystring: { type_script: string } }>('/type', (request) => getTypeScript(request.query.type_script));
    try {
      const response = await app.inject({ url: '/type?type_script=' + encodeURIComponent(type_script) });
      expect(response.statusCode).toBe(400);
      expect(response.json().message).toBe('Invalid type_script');
    } finally {
      await app.close();
    }
  });

  it('requires concrete args for the actual asset metadata route without changing filters', async () => {
    const app = Fastify();
    const getInfoCellData = vi.fn().mockResolvedValue(null);
    app.decorate('ckb', { getInfoCellData } as unknown as CKBClient);
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.register(assetsRoute, { prefix: '/rgbpp/v1/assets' });
    const xudt = getXudtTypeScript(false);
    const getMetadata = (args: string) =>
      app.inject({
        url: '/rgbpp/v1/assets/type?type_script=' + encodeURIComponent(JSON.stringify({ ...xudt, args })),
      });
    try {
      expect(getTypeScript(xudt)?.args).toBe('');
      expect((await getMetadata('')).statusCode).toBe(400);
      expect(getInfoCellData).not.toHaveBeenCalled();
      expect((await getMetadata('0x')).statusCode).toBe(200);
      expect(getInfoCellData).toHaveBeenCalledWith({ ...xudt, args: '0x' });
    } finally {
      await app.close();
    }
  });
});
