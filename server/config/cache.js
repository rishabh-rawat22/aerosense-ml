const NodeCache = require('node-cache');
const logger = require('./logger');

const cache = new NodeCache({ stdTTL: 600, checkperiod: 120, useClones: false });

const cacheService = {
  get: (key) => {
    const val = cache.get(key);
    if (val !== undefined) {
      logger.debug(`Cache HIT: ${key}`);
      return val;
    }
    logger.debug(`Cache MISS: ${key}`);
    return null;
  },

  set: (key, value, ttl = 600) => {
    cache.set(key, value, ttl);
    logger.debug(`Cache SET: ${key} (TTL: ${ttl}s)`);
  },

  del: (key) => {
    cache.del(key);
  },

  flush: () => {
    cache.flushAll();
    logger.info('Cache flushed');
  },

  stats: () => cache.getStats(),

  wrap: async (key, fn, ttl = 600) => {
    const cached = cacheService.get(key);
    if (cached !== null) return cached;
    const result = await fn();
    cacheService.set(key, result, ttl);
    return result;
  },
};

module.exports = cacheService;
