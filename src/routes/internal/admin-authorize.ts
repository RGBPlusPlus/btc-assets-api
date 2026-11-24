import { createHash, timingSafeEqual } from 'node:crypto';
import { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../../env';

const digest = (value: string) => createHash('sha256').update(value).digest();

export default async function adminAuthorize(request: FastifyRequest, reply: FastifyReply) {
  const { ADMIN_USERNAME: username, ADMIN_PASSWORD: password } = env;
  const token = /^Basic +([A-Za-z0-9+/]+={0,2})$/i.exec(request.headers.authorization ?? '')?.[1];

  if (username && !username.includes(':') && password && token) {
    const decoded = Buffer.from(token, 'base64').toString();
    if (timingSafeEqual(digest(decoded), digest(`${username}:${password}`))) return;
  }

  reply.code(401).header('WWW-Authenticate', 'Basic realm="Internal Administration"').send({ error: 'Unauthorized' });
}
