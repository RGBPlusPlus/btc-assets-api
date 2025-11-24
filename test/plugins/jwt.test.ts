import { beforeAll, afterEach, describe, test, expect, vi } from 'vitest';
import { buildFastify } from '../../src/app';
import container from '../../src/container';
import { JwtPayload } from '../../src/plugins/jwt';

describe('JWT Plugin', () => {
  let token: string;
  let decodedToken: JwtPayload;

  beforeAll(async () => {
    const fastify = buildFastify();
    await fastify.ready();

    const payload = {
      sub: 'test',
      aud: 'test.com',
    };
    const tokenResponse = await fastify.inject({
      method: 'POST',
      url: '/token/generate',
      payload: {
        app: payload.sub,
        domain: payload.aud,
      },
    });
    const data = tokenResponse.json();
    token = data.token;
    decodedToken = { ...payload, jti: data.id };
  });

  afterEach(() => {
    const env = container.resolve('env');
    env.JWT_DENYLIST = [];
    vi.restoreAllMocks();
  });

  test('should fastify.jwt be defined', async () => {
    const fastify = buildFastify();
    await fastify.ready();

    expect(fastify.hasDecorator('jwt')).toBeDefined();

    await fastify.close();
  });

  test('should be return 401 if token is not provided', async () => {
    const fastify = buildFastify();
    await fastify.ready();

    const response = await fastify.inject({
      method: 'GET',
      url: '/bitcoin/v1/info',
    });

    expect(response.statusCode).toBe(401);

    await fastify.close();
  });

  test('should be return 401 if token origin/referer is not match', async () => {
    const fastify = buildFastify();
    await fastify.ready();

    const response = await fastify.inject({
      method: 'GET',
      url: '/bitcoin/v1/info',
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'https://example.com',
      },
    });

    expect(response.statusCode).toBe(401);

    await fastify.close();
  });

  test('should be return 401 if token is denied', async () => {
    const env = container.resolve('env');
    env.JWT_DENYLIST = [token];

    const fastify = buildFastify();
    await fastify.ready();

    const response = await fastify.inject({
      method: 'GET',
      url: '/bitcoin/v1/info',
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'https://test.com',
      },
    });

    expect(response.statusCode).toBe(401);
    await fastify.close();
  });

  test.each<keyof JwtPayload>(['sub', 'aud', 'jti'])('should be return 401 if token.%s is denied', async (key) => {
    const env = container.resolve('env');
    env.JWT_DENYLIST = [decodedToken[key]];

    const fastify = buildFastify();
    await fastify.ready();

    const response = await fastify.inject({
      method: 'GET',
      url: '/bitcoin/v1/info',
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'https://test.com',
      },
    });

    expect(response.statusCode).toBe(401);
    await fastify.close();
  });

  describe('JWT Error Logging', () => {
    test('should log JWT info when authenticated request returns 4xx error', async () => {
      const fastify = buildFastify();
      await fastify.ready();

      const logSpy = vi.spyOn(fastify.log, 'warn');

      const response = await fastify.inject({
        method: 'GET',
        url: '/bitcoin/v1/info',
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: 'https://example.com', // Wrong origin to trigger 401
        },
      });

      expect(response.statusCode).toBe(401);
      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          jti: decodedToken.jti,
          app: decodedToken.sub,
          domain: decodedToken.aud,
          ip: '127.0.0.1',
          statusCode: 401,
        }),
        expect.stringContaining('[JWT Trace] GET /bitcoin/v1/info'),
      );

      await fastify.close();
    });

    test('should not log JWT info when request returns 2xx success', async () => {
      const fastify = buildFastify();
      await fastify.ready();

      const logSpy = vi.spyOn(fastify.log, 'warn');

      const response = await fastify.inject({
        method: 'GET',
        url: '/bitcoin/v1/info',
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: 'https://test.com',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(logSpy).not.toHaveBeenCalled();

      await fastify.close();
    });

    test('should not log JWT info when unauthenticated request returns error', async () => {
      const fastify = buildFastify();
      await fastify.ready();

      const logSpy = vi.spyOn(fastify.log, 'warn');

      const response = await fastify.inject({
        method: 'GET',
        url: '/bitcoin/v1/info',
        // No Authorization header
      });

      expect(response.statusCode).toBe(401);
      // Should log IP Activity, but not JWT Trace
      const jwtTraceCalls = logSpy.mock.calls.filter((call) => {
        const msg = call[1] as string;
        return msg?.includes('[JWT Trace]');
      });
      expect(jwtTraceCalls).toHaveLength(0);

      await fastify.close();
    });

    test('should handle JWT without jti (optional field)', async () => {
      const fastify = buildFastify();
      await fastify.ready();

      // Generate token without jti (for forwarding capability)
      const payloadWithoutJti = {
        sub: 'test-forward',
        aud: 'forward.com',
      };
      const forwardTokenResponse = await fastify.inject({
        method: 'POST',
        url: '/token/generate',
        payload: {
          app: payloadWithoutJti.sub,
          domain: payloadWithoutJti.aud,
        },
      });
      const forwardToken = forwardTokenResponse.json().token;

      const logSpy = vi.spyOn(fastify.log, 'warn');

      const response = await fastify.inject({
        method: 'GET',
        url: '/bitcoin/v1/info',
        headers: {
          Authorization: `Bearer ${forwardToken}`,
          Origin: 'https://wrong.com', // Wrong origin to trigger 401
        },
      });

      expect(response.statusCode).toBe(401);
      // Should still log even if jti is undefined
      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          jti: expect.anything(), // jti might be undefined
          app: payloadWithoutJti.sub,
          domain: payloadWithoutJti.aud,
        }),
        expect.stringContaining('[JWT Trace]'),
      );

      await fastify.close();
    });
  });
});
