import { FastifyRequest } from 'fastify';
import cors, { FastifyCorsOptions } from '@fastify/cors';
import fp from 'fastify-plugin';
import { JWT_IGNORE_URLS } from '../constants';
import { env } from '../env';

export default fp(async (fastify) => {
  await fastify.register(cors, () => {
    return async (request: FastifyRequest) => {
      const corsOptions: FastifyCorsOptions = {
        hook: 'preHandler',
        origin: false,
        maxAge: 60 * 60 * 24,
      };

      if (
        request.method.toLowerCase() === 'options' ||
        JWT_IGNORE_URLS.some((prefix) => request.url.startsWith(prefix))
      ) {
        corsOptions.origin = true;
        return corsOptions;
      }

      // Development environment: allow all origins
      if (env.NODE_ENV === 'development') {
        corsOptions.origin = true;
        return corsOptions;
      }

      // Production environment: enable JWT-based CORS validation
      const { origin } = request.headers;
      const jwt = (await request.jwtDecode()) as { aud: string };
      if (!origin || new URL(origin).hostname !== jwt.aud) {
        return corsOptions;
      }
      corsOptions.origin = origin;
      return corsOptions;
    };
  });
});
