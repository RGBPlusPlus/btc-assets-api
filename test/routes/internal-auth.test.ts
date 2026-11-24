import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { validatorCompiler } from 'fastify-type-provider-zod';
import internalRoutes from '../../src/routes/internal';

const fixture = vi.hoisted(() => ({
  env: { NODE_ENV: 'development', PUBLIC_API_JWT_REQUIRED: false, ADMIN_USERNAME: '', ADMIN_PASSWORD: '' },
  handler: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('../../src/env', () => ({ env: fixture.env }));
vi.mock('../../src/container', () => ({ default: { resolve: fixture.resolve } }));

// Exercise the actual internal route scope and auth hook without registering queue actions.
vi.mock('../../src/routes/internal/job', async () => {
  const { z } = await import('zod');
  return {
    default: async (app: FastifyInstance) => {
      app.post('/fixture', { schema: { body: z.object({ label: z.string() }) } }, async () => fixture.handler());
    },
  };
});

const path = '/internal/job/fixture';
const user = 'unit-test-admin';
const password = 'fixture:only';

describe('internal administrative route policy', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.get('/public-fixture', async () => ({ ok: true }));
    app.register(internalRoutes, { prefix: '/internal' });
    fixture.resolve.mockReturnValue({});
    fixture.handler.mockReturnValue({ ok: true });
    fixture.env.ADMIN_USERNAME = user;
    fixture.env.ADMIN_PASSWORD = password;
  });

  afterEach(async () => {
    await app.close();
  });

  test.each([
    ['', ''],
    [user, ''],
    ['', password],
  ])('does not register internal routes with missing credentials (%s, %s)', async (username, password) => {
    fixture.env.ADMIN_USERNAME = username;
    fixture.env.ADMIN_PASSWORD = password;

    expect((await app.inject({ method: 'POST', url: path })).statusCode).toBe(404);
    expect(fixture.resolve).not.toHaveBeenCalled();
    expect(fixture.handler).not.toHaveBeenCalled();
    expect((await app.inject('/public-fixture')).statusCode).toBe(200);
  });

  test.each([
    ['development', false],
    ['development', true],
    ['production', false],
    ['production', true],
  ] as const)('authenticates before validation (%s, public JWT required=%s)', async (mode, jwtRequired) => {
    fixture.env.NODE_ENV = mode;
    fixture.env.PUBLIC_API_JWT_REQUIRED = jwtRequired;

    const valid = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
    const invalid = `Basic ${Buffer.from(`${user}:wrong`).toString('base64')}`;

    for (const authorization of [undefined, 'Basic', invalid]) {
      const headers = authorization ? { authorization } : {};
      const response = await app.inject({ method: 'POST', url: path, headers });
      expect(response.statusCode).toBe(401);
      expect(response.headers['www-authenticate']).toBe('Basic realm="Internal Administration"');
    }
    expect(fixture.handler).not.toHaveBeenCalled();

    const headers = { authorization: valid };
    expect((await app.inject({ method: 'POST', url: path, headers })).statusCode).toBe(400);
    expect(fixture.handler).not.toHaveBeenCalled();

    const response = await app.inject({ method: 'POST', url: path, headers, payload: { label: 'fixture' } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['www-authenticate']).toBeUndefined();
    expect(fixture.handler).toHaveBeenCalledTimes(1);
  });
});
