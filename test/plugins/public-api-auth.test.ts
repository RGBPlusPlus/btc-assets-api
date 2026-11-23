import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { env } from '../../src/env';
import cors from '../../src/plugins/cors';
import jwt from '../../src/plugins/jwt';
import { markPublicApiRoute } from '../../src/plugins/public-api-auth';
import swagger from '../../src/plugins/swagger';

const origin = 'https://client.example';
const originalJwtRequired = env.PUBLIC_API_JWT_REQUIRED;
const originalNodeEnv = env.NODE_ENV;
const originalDenylist = env.JWT_DENYLIST;
let app: FastifyInstance | undefined;

async function buildFixture(jwtRequired?: boolean) {
  env.NODE_ENV = 'production';
  if (jwtRequired !== undefined) env.PUBLIC_API_JWT_REQUIRED = jwtRequired;
  const server = Fastify({ logger: false });
  app = server;
  const sentryStub: Pick<FastifyInstance['Sentry'], 'setTag' | 'setTags'> = {
    setTag: () => {},
    setTags: () => {},
  };
  server.decorate('Sentry', sentryStub as FastifyInstance['Sentry']);
  await server.register(cors);
  await server.register(jwt);
  await server.register(swagger);
  server.register(async (publicApi) => {
    publicApi.addHook('onRoute', markPublicApiRoute);

    publicApi.register(
      async (bitcoin) => {
        bitcoin.get('/info', { schema: { tags: ['Bitcoin'] } }, async () => ({ ok: true }));
        bitcoin.post('/transaction', async () => ({ ok: true }));
      },
      { prefix: '/bitcoin/v1' },
    );
    publicApi.register(
      async (rgbpp) => {
        rgbpp.post('/transaction/ckb-tx', async () => ({ ok: true }));
      },
      { prefix: '/rgbpp/v1' },
    );
    publicApi.register(
      async (rgbpp) => {
        rgbpp.get('/assets', async () => ({ ok: true }));
      },
      { prefix: '/rgbpp/v2' },
    );
  });
  server.get('/bitcoin/v1/admin-fixture', async () => ({ ok: true }));
  server.get('/bitcoin/v10/info', { schema: { tags: ['Private'] } }, async () => ({ ok: true }));
  server.get('/admin/fixture', async () => ({ ok: true }));
  for (const path of ['/internal/fixture', '/cron/fixture', '/token/fixture', '/healthcheck']) {
    server.get(path, async () => ({ ok: true }));
  }
  await server.ready();
  return server;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  env.PUBLIC_API_JWT_REQUIRED = originalJwtRequired;
  env.NODE_ENV = originalNodeEnv;
  env.JWT_DENYLIST = originalDenylist;
});

describe('public API JWT policy', () => {
  test('requires a valid JWT and matching origin by default', async () => {
    expect(env.PUBLIC_API_JWT_REQUIRED).toBe(true);
    const server = await buildFixture();
    const url = '/bitcoin/v1/info';
    const token = server.jwt.sign({ sub: 'client', aud: 'client.example', jti: 'fixture' });
    const headers = { authorization: `Bearer ${token}`, origin };
    expect((await server.inject({ url, headers: { origin } })).statusCode).toBe(401);
    expect((await server.inject({ url, headers: { ...headers, origin: 'https://other.example' } })).statusCode).toBe(401);
    const authorized = await server.inject({ url, headers });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.headers['access-control-allow-origin']).toBe(origin);
    env.JWT_DENYLIST = ['fixture'];
    expect((await server.inject({ url, headers })).statusCode).toBe(401);
  });

  test('allows anonymous reads and writes in only the registered public scope', async () => {
    const server = await buildFixture(false);
    for (const [method, url] of [
      ['GET', '/bitcoin/v1/info'],
      ['POST', '/bitcoin/v1/transaction'],
      ['POST', '/rgbpp/v1/transaction/ckb-tx'],
      ['GET', '/rgbpp/v2/assets'],
    ] as const) {
      const result = await server.inject({ method, url, headers: { origin } });
      expect(result.statusCode).toBe(200);
      expect(result.headers['access-control-allow-origin']).toBe(origin);
    }
    const url = '/bitcoin/v1/info';
    expect((await server.inject({ url })).statusCode).toBe(200);
    expect((await server.inject({ url, headers: { origin, authorization: 'Bearer ignored' } })).statusCode).toBe(200);
    for (const path of ['/bitcoin/v1/admin-fixture', '/bitcoin/v10/info', '/admin/fixture']) {
      expect((await server.inject({ url: path, headers: { origin } })).statusCode).toBe(401);
    }
  });

  test.each([true, false])('keeps existing exempt routes and browser preflight (JWT required: %s)', async (enabled) => {
    const server = await buildFixture(enabled);
    for (const url of ['/internal/fixture', '/cron/fixture', '/token/fixture', '/healthcheck', '/docs/json']) {
      expect((await server.inject({ url })).statusCode).toBe(200);
    }
    const preflight = await server.inject({
      method: 'OPTIONS',
      url: '/rgbpp/v1/transaction/ckb-tx',
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'Content-Type' },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(origin);
  });

  test.each([true, false])('describes authentication per operation (JWT required: %s)', async (enabled) => {
    const server = await buildFixture(enabled);
    const docs = (await server.inject('/docs/json')).json();
    expect(docs.security).toEqual([{ apiKey: [] }]);
    expect(docs.paths['/bitcoin/v1/info'].get.security).toEqual(enabled ? undefined : []);
    expect(docs.paths['/bitcoin/v10/info'].get.security).toBeUndefined();
  });
});
