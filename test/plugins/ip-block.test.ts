import { afterEach } from 'node:test';
import { describe, expect, test, vi } from 'vitest';
import container from '../../src/container';
import { Env } from '../../src/env';
import { buildFastify } from '../../src/app';

describe('IP Blocklist Plugin', () => {
  afterEach(() => {
    const env: Env = container.resolve('env');
    env.IP_BLOCKLIST = [];
    vi.restoreAllMocks();
  });

  test('should block IP if it is in the blocklist', async () => {
    const env: Env = container.resolve('env');
    env.IP_BLOCKLIST = ['127.0.0.1'];

    const fastify = buildFastify();
    await fastify.ready();

    const response = await fastify.inject({
      method: 'GET',
      url: '/docs',
    });

    expect(response.statusCode).toBe(403);

    await fastify.close();
  });

  test('should not block IP if it is not in the blocklist', async () => {
    const env: Env = container.resolve('env');
    env.IP_BLOCKLIST = [];

    const fastify = buildFastify();
    await fastify.ready();

    const response = await fastify.inject({
      method: 'GET',
      url: '/docs',
    });

    expect(response.statusCode).not.toBe(403);

    await fastify.close();
  });

  describe('IP Activity Logging', () => {
    test('should log IP activity for 401 Unauthorized error', async () => {
      const fastify = buildFastify();
      await fastify.ready();

      const logSpy = vi.spyOn(fastify.log, 'warn');

      const response = await fastify.inject({
        method: 'GET',
        url: '/bitcoin/v1/info',
        headers: {
          'user-agent': 'test-agent/1.0',
        },
        // No auth header, should get 401
      });

      expect(response.statusCode).toBe(401);
      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          ip: '127.0.0.1',
          statusCode: 401,
          userAgent: 'test-agent/1.0',
        }),
        expect.stringContaining('[IP Activity] GET /bitcoin/v1/info'),
      );

      await fastify.close();
    });

    test('should log IP activity for 403 Forbidden error', async () => {
      const env: Env = container.resolve('env');
      env.IP_BLOCKLIST = ['127.0.0.1'];

      const fastify = buildFastify();
      await fastify.ready();

      const logSpy = vi.spyOn(fastify.log, 'warn');

      const response = await fastify.inject({
        method: 'GET',
        url: '/docs',
        headers: {
          'user-agent': 'malicious-bot/1.0',
        },
      });

      expect(response.statusCode).toBe(403);
      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          ip: '127.0.0.1',
          statusCode: 403,
          userAgent: 'malicious-bot/1.0',
        }),
        expect.stringContaining('[IP Activity] GET /docs'),
      );

      await fastify.close();
    });

    test('should use default user agent from fastify.inject', async () => {
      const fastify = buildFastify();
      await fastify.ready();

      const logSpy = vi.spyOn(fastify.log, 'warn');

      const response = await fastify.inject({
        method: 'GET',
        url: '/bitcoin/v1/info',
        // fastify.inject automatically adds 'lightMyRequest' as user-agent
      });

      expect(response.statusCode).toBe(401);
      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          ip: '127.0.0.1',
          statusCode: 401,
          userAgent: 'lightMyRequest', // Default from fastify.inject
        }),
        expect.stringContaining('[IP Activity]'),
      );

      await fastify.close();
    });

    test('should not log IP activity for 2xx success responses', async () => {
      const env: Env = container.resolve('env');
      env.IP_BLOCKLIST = []; // Ensure IP is not blocked

      const fastify = buildFastify();
      await fastify.ready();

      const logSpy = vi.spyOn(fastify.log, 'warn');

      // Use /docs which is publicly accessible
      const response = await fastify.inject({
        method: 'GET',
        url: '/docs',
        headers: {
          'user-agent': 'test-agent/1.0',
        },
      });

      // /docs redirects (3xx) or returns success (2xx)
      expect(response.statusCode).toBeLessThan(400);
      // Filter for IP Activity logs only
      const ipActivityCalls = logSpy.mock.calls.filter((call) => {
        const msg = call[1] as string;
        return msg?.includes('[IP Activity]');
      });
      expect(ipActivityCalls).toHaveLength(0);

      await fastify.close();
    });

    test('should not log IP activity for 4xx errors other than 401/403/429', async () => {
      const fastify = buildFastify();
      await fastify.ready();

      const logSpy = vi.spyOn(fastify.log, 'warn');

      const response = await fastify.inject({
        method: 'GET',
        url: '/non-existent-route',
        headers: {
          'user-agent': 'test-agent/1.0',
        },
      });

      expect(response.statusCode).toBe(404);
      // Filter for IP Activity logs only
      const ipActivityCalls = logSpy.mock.calls.filter((call) => {
        const msg = call[1] as string;
        return msg?.includes('[IP Activity]');
      });
      expect(ipActivityCalls).toHaveLength(0);

      await fastify.close();
    });

    test('should not log IP activity for 5xx server errors', async () => {
      const fastify = buildFastify();

      // Add route before ready() to avoid "already listening" error
      fastify.get('/test-500', async () => {
        throw new Error('Internal server error');
      });

      await fastify.ready();

      const logSpy = vi.spyOn(fastify.log, 'warn');

      const response = await fastify.inject({
        method: 'GET',
        url: '/test-500',
        headers: {
          'user-agent': 'test-agent/1.0',
        },
      });

      expect(response.statusCode).toBe(500);
      // Filter for IP Activity logs only
      const ipActivityCalls = logSpy.mock.calls.filter((call) => {
        const msg = call[1] as string;
        return msg?.includes('[IP Activity]');
      });
      expect(ipActivityCalls).toHaveLength(0);

      await fastify.close();
    });
  });
});
