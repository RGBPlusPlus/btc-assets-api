import fp from 'fastify-plugin';
import { HttpStatusCode } from 'axios';
import { env } from '../env';

export default fp(async (fastify) => {
  try {
    fastify.addHook('onRequest', async (request, reply) => {
      const ip = request.ip;
      fastify.log.info(`IP: ${ip}`);
      if (env.IP_BLOCKLIST.includes(ip)) {
        reply.code(HttpStatusCode.Forbidden).send('Forbidden');
        return;
      }
    });

    // Log suspicious IP activities (authentication/authorization failures)
    fastify.addHook('onResponse', async (request, reply) => {
      const statusCode = reply.statusCode;

      // Only log security-related errors: 401, 403, 429
      if (
        ![HttpStatusCode.Unauthorized, HttpStatusCode.Forbidden, HttpStatusCode.TooManyRequests].includes(statusCode)
      ) {
        return;
      }

      fastify.log.warn(
        {
          ip: request.ip,
          statusCode,
          userAgent: request.headers['user-agent'] || 'unknown',
        },
        `[IP Activity] ${request.method} ${request.url}`,
      );
    });
  } catch (err) {
    fastify.log.error(err);
    fastify.Sentry.captureException(err);
  }
});
