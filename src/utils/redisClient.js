const { createClient } = require('redis');

let client;

function getRedisUrlFromEnv() {
  if (process.env.REDIS_URL) return process.env.REDIS_URL;
  const host = process.env.REDIS_HOST || '127.0.0.1';
  const port = process.env.REDIS_PORT || '6379';
  const password = process.env.REDIS_PASSWORD ? `:${process.env.REDIS_PASSWORD}@` : '';
  return `redis://${password}${host}:${port}`;
}

async function getRedisClient() {
  if (client) return client;
  const url = getRedisUrlFromEnv();
  client = createClient({ url });
  client.on('error', (err) => {
    console.error('Redis Client Error', err);
  });
  await client.connect();
  return client;
}

module.exports = { getRedisClient };
