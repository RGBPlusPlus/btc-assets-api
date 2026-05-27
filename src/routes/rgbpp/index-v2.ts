import { FastifyPluginCallback } from 'fastify';
import { Server } from 'http';
import container from '../../container';
import transactionRouteV2 from './transaction-v2';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import addressRoutesV2 from './address-v2';

const rgbppRoutesV2: FastifyPluginCallback<Record<never, never>, Server, ZodTypeProvider> = (fastify, _, done) => {
  fastify.decorate('transactionProcessor', container.resolve('transactionProcessor'));
  fastify.decorate('rgbppCollector', container.resolve('rgbppCollector'));
  fastify.decorate('ckb', container.resolve('ckb'));
  fastify.decorate('bitcoin', container.resolve('bitcoin'));

  fastify.register(transactionRouteV2, { prefix: '/transaction' });
  fastify.register(addressRoutesV2, { prefix: '/address' });
  done();
};

export default rgbppRoutesV2;
