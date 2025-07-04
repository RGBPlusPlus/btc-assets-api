import { FastifyPluginCallback } from 'fastify';
import { Server } from 'http';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import generateRoute from './generate';
import { env } from '../../env';
import adminAuthorize from '../../hooks/admin-authorize';

const tokenRoutes: FastifyPluginCallback<Record<never, never>, Server, ZodTypeProvider> = (fastify, _, done) => {
  // Add admin authorization only in production environment
  if (env.NODE_ENV === 'production' && env.ADMIN_USERNAME && env.ADMIN_PASSWORD) {
    fastify.addHook('onRequest', adminAuthorize);
  }

  // Register /token/generate in all environments
  // - Development: no authentication required, hidden from Swagger
  // - Production: requires admin authentication, hidden from Swagger
  fastify.register(generateRoute);

  done();
};

export default tokenRoutes;
