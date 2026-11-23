import type { FastifyContextConfig, RouteOptions } from 'fastify';
import { env } from '../env';

export function markPublicApiRoute(route: RouteOptions) {
  route.config = { ...route.config, publicApi: true };
}

export function isUnauthenticatedPublicApi(config: FastifyContextConfig | undefined) {
  return env.PUBLIC_API_JWT_REQUIRED === false && config?.publicApi === true;
}
