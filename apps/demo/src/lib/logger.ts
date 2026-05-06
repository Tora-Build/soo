/**
 * Production-safe logger utility
 * 
 * Only logs in development mode (import.meta.env.DEV)
 * Provides structured logging with namespaces for easier debugging
 */

const isDev = import.meta.env.DEV;

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LoggerOptions {
  /** Enable logging even in production (use sparingly) */
  forceLog?: boolean;
}

function createLogger(namespace: string, options: LoggerOptions = {}) {
  const shouldLog = (level: LogLevel) => {
    if (options.forceLog) return true;
    if (!isDev) return level === 'error'; // Always log errors
    return true;
  };

  const format = (level: LogLevel, ...args: unknown[]) => {
    const prefix = `[${namespace}]`;
    return [prefix, ...args];
  };

  return {
    debug: (...args: unknown[]) => {
      if (shouldLog('debug')) {
        console.debug(...format('debug', ...args));
      }
    },
    log: (...args: unknown[]) => {
      if (shouldLog('info')) {
        console.log(...format('info', ...args));
      }
    },
    info: (...args: unknown[]) => {
      if (shouldLog('info')) {
        console.info(...format('info', ...args));
      }
    },
    warn: (...args: unknown[]) => {
      if (shouldLog('warn')) {
        console.warn(...format('warn', ...args));
      }
    },
    error: (...args: unknown[]) => {
      if (shouldLog('error')) {
        console.error(...format('error', ...args));
      }
    },
  };
}

// Pre-configured loggers for common namespaces
export const logger = {
  // Trading operations
  trade: createLogger('Trade'),
  order: createLogger('Order'),
  claim: createLogger('Claim'),
  cancel: createLogger('Cancel'),
  
  // Market operations
  market: createLogger('Market'),
  launchpad: createLogger('Launchpad'),
  
  // UI/UX
  ui: createLogger('UI'),
  wallet: createLogger('Wallet'),
  chain: createLogger('Chain'),
  
  // Data fetching
  rpc: createLogger('RPC'),
  indexer: createLogger('Indexer'),
  
  // Create custom namespace
  create: createLogger,
};

export default logger;
