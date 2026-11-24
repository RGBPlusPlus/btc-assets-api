import { env } from './env';
import { buildFastify } from './app';
import * as Sentry from '@sentry/node';

async function start() {
  try {
    const port = parseInt(env.PORT || '3000', 10);
    const host = env.ADDRESS || '0.0.0.0';
    const app = buildFastify();
    const address = await app.listen({ port, host });

    // eslint-disable-next-line no-console
    console.log(`Server listening at ${address}`);
  } catch (err) {
    console.error(err);
    try {
      Sentry.captureException(err);
      await Sentry.flush(2000);
    } finally {
      // A failed Fastify boot can leave Redis and worker connections open.
      process.exit(1);
    }
  }
}

void start();
