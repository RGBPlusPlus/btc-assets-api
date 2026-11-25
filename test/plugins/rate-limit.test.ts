import Fastify from 'fastify';
import { afterEach, expect, test, vi } from 'vitest';

const originalLimit = process.env.RATE_LIMIT_PER_MINUTE;

async function fixture(value: string | undefined) {
  if (value === undefined) delete process.env.RATE_LIMIT_PER_MINUTE;
  else process.env.RATE_LIMIT_PER_MINUTE = value;
  vi.resetModules();
  const { default: rateLimit } = await import('../../src/plugins/rate-limit');
  const app = Fastify();
  const resolve = vi.fn(() => undefined); // Use the Fastify limiter's in-memory store.
  app.decorate('container', { resolve });
  await app.register(rateLimit);
  app.get('/info', async () => ({ ok: true }));
  return { app, resolve };
}

afterEach(() => {
  if (originalLimit === undefined) delete process.env.RATE_LIMIT_PER_MINUTE;
  else process.env.RATE_LIMIT_PER_MINUTE = originalLimit;
});

test('zero disables application rate limiting without resolving Redis', async () => {
  const { app, resolve } = await fixture('0');
  try {
    for (let i = 0; i < 2; i++) {
      const response = await app.inject('/info');
      expect(response.statusCode).toBe(200);
      expect(response.headers['x-ratelimit-limit']).toBeUndefined();
    }
    expect(resolve).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test('a positive limit still applies to requests from the same IP', async () => {
  const { app, resolve } = await fixture('1');
  try {
    expect((await app.inject('/info')).statusCode).toBe(200);
    expect((await app.inject('/info')).statusCode).toBe(429);
    expect(resolve).toHaveBeenCalledWith('redis');
  } finally {
    await app.close();
  }
});

test.each([undefined, '', '   '])('defaults to 100 requests for %j', async (value) => {
  const { app } = await fixture(value);
  try {
    const response = await app.inject('/info');
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-ratelimit-limit']).toBe('100');
  } finally {
    await app.close();
  }
});
