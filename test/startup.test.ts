import { afterEach, beforeEach, describe, type MockInstance, expect, test, vi } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';

const mock = vi.hoisted(() => ({
  buildFastify: vi.fn(),
  captureException: vi.fn(),
  flush: vi.fn(),
}));

vi.mock('../src/app', () => ({ buildFastify: mock.buildFastify }));
vi.mock('../src/env', () => ({ env: { PORT: '0', ADDRESS: '127.0.0.1' } }));
vi.mock('@sentry/node', () => ({ captureException: mock.captureException, flush: mock.flush }));

describe('standalone startup', () => {
  let app: FastifyInstance;
  let exit: MockInstance<Parameters<typeof process.exit>, never>;
  let log: MockInstance<Parameters<typeof console.log>, void>;
  let error: MockInstance<Parameters<typeof console.error>, void>;

  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    app = fastify();
    mock.buildFastify.mockReturnValue(app);
    mock.flush.mockResolvedValue(true);
    exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test.each(['Bitcoin RPC unavailable', 'Bitcoin client is not running on testnet'])(
    'exits nonzero on a mandatory startup check failure: %s',
    async (message) => {
      const cause = new Error(message);
      app.register(async () => {
        throw cause;
      });

      await import('../src/index');
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));

      expect(error).toHaveBeenCalledWith(cause);
      expect(mock.captureException).toHaveBeenCalledWith(cause);
      expect(mock.flush).toHaveBeenCalledWith(2000);
      expect(log).not.toHaveBeenCalled();
      expect(app.server.listening).toBe(false);
    },
  );

  test('exits nonzero when the listen address is already in use', async () => {
    const occupied = fastify();
    try {
      await occupied.listen({ port: 0, host: '127.0.0.1' });
      const address = occupied.server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP listen address');
      const listen = app.listen.bind(app);
      vi.spyOn(app, 'listen').mockImplementationOnce(() => listen({ port: address.port, host: '127.0.0.1' }));

      await import('../src/index');
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
      expect(error).toHaveBeenCalledWith(expect.objectContaining({ code: 'EADDRINUSE' }));
      expect(log).not.toHaveBeenCalled();
    } finally {
      await occupied.close();
    }
  });

  test('only reports success after binding and serving HTTP', async () => {
    app.get('/health', async () => ({ ready: true }));
    await import('../src/index');
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Server listening at http:/)));

    const message = String(log.mock.calls[0][0]);
    const response = await fetch(message.slice('Server listening at '.length) + '/health');
    expect(await response.json()).toEqual({ ready: true });
    expect(exit).not.toHaveBeenCalled();
  });
});
