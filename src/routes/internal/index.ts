import { FastifyPluginCallback } from 'fastify';
import { Server } from 'http';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { env } from '../../env';
import { createAdminAuthorize } from '../../hooks/admin-authorize';
import jobRoutes from './job';
import container from '../../container';

const adminAuthorize = createAdminAuthorize('Basic realm="Internal Administration"');

const internalRoutes: FastifyPluginCallback<Record<never, never>, Server, ZodTypeProvider> = (fastify, _, done) => {
  // Internal administration is opt-in and independent of public API JWTs.
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) {
    done();
    return;
  }
  fastify.addHook('onRequest', adminAuthorize);

  fastify.decorate('transactionProcessor', container.resolve('transactionProcessor'));

  fastify.register(jobRoutes, { prefix: '/job' });
  done();
};

export default internalRoutes;
