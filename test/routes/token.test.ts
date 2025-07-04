import { expect, test, beforeEach, afterEach } from 'vitest';
import { buildFastify } from '../../src/app';
import container from '../../src/container';

let originalNodeEnv: string;

beforeEach(() => {
  // Save original NODE_ENV
  originalNodeEnv = process.env.NODE_ENV || 'development';
  // Set NODE_ENV to production to enable admin authentication
  process.env.NODE_ENV = 'production';
  // Update container env
  const env = container.resolve('env');
  env.NODE_ENV = 'production';
});

afterEach(() => {
  // Restore original NODE_ENV
  process.env.NODE_ENV = originalNodeEnv;
  // Update container env
  const env = container.resolve('env');
  env.NODE_ENV = originalNodeEnv;
});

test('`/token/generate` - successfully', async () => {
  const fastify = buildFastify();
  await fastify.ready();

  const response = await fastify.inject({
    method: 'POST',
    url: '/token/generate',
    payload: {
      app: 'test',
      domain: 'test.com',
    },
  });
  const data = response.json();

  expect(response.statusCode).toBe(200);
  expect(data.token).toBeDefined();

  await fastify.close();
});

test('`/token/generate` - without params', async () => {
  const fastify = buildFastify();
  await fastify.ready();

  const response = await fastify.inject({
    method: 'POST',
    url: '/token/generate',
  });
  const data = response.json();

  expect(response.statusCode).toBe(400);
  expect(data.message).toMatchSnapshot();

  await fastify.close();
});

test('`/token/generate` - invalid domain', async () => {
  const fastify = buildFastify();
  await fastify.ready();

  const response = await fastify.inject({
    method: 'POST',
    url: '/token/generate',
    payload: {
      app: 'test',
      domain: '\\',
    },
  });
  const data = response.json();

  expect(response.statusCode).toBe(500);
  expect(data.message).toEqual('Failed to generate token: Invalid URL');

  await fastify.close();
});

test('`/token/generate` - with pathname', async () => {
  const fastify = buildFastify();
  await fastify.ready();

  const response = await fastify.inject({
    method: 'POST',
    url: '/token/generate',
    payload: {
      app: 'test',
      domain: 'http://test.com/abc',
    },
  });
  const data = response.json();

  expect(response.statusCode).toBe(500);
  expect(data.message).toEqual('Failed to generate token: Must be a valid domain without path');

  await fastify.close();
});

test('`/token/generate` - with protocol', async () => {
  const fastify = buildFastify();
  await fastify.ready();

  const response = await fastify.inject({
    method: 'POST',
    url: '/token/generate',
    payload: {
      app: 'test',
      domain: 'https://test.com',
    },
  });
  const data = response.json();

  expect(response.statusCode).toBe(200);
  expect(data.token).toBeDefined();

  await fastify.close();
});

test('`/token/generate` - with port', async () => {
  const fastify = buildFastify();
  await fastify.ready();

  const response = await fastify.inject({
    method: 'POST',
    url: '/token/generate',
    payload: {
      app: 'test',
      domain: 'test.com:3000',
    },
  });
  const data = response.json();

  expect(response.statusCode).toBe(200);
  expect(data.token).toBeDefined();

  await fastify.close();
});

test('`/token/generate` - available in development environment without authentication', async () => {
  // Set NODE_ENV to development for this test
  process.env.NODE_ENV = 'development';
  const env = container.resolve('env');
  env.NODE_ENV = 'development';

  const fastify = buildFastify();
  await fastify.ready();

  const response = await fastify.inject({
    method: 'POST',
    url: '/token/generate',
    payload: {
      app: 'test',
      domain: 'test.com',
    },
  });

  expect(response.statusCode).toBe(200);
  const data = response.json();
  expect(data.token).toBeDefined();

  await fastify.close();
});
