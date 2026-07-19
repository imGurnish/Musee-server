const EventEmitter = require('events');

const logEmitter = new EventEmitter();
const logBuffer = [];
const MAX_BUFFER_SIZE = 200;

// Save original console functions to bypass recursion
const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
};

// Regex to remove ANSI colors/escape sequences from morgan or external tools
const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function formatMessage(args) {
  return args
    .map((arg) => {
      if (arg instanceof Error) return arg.stack || arg.message;
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg);
        } catch (e) {
          return String(arg);
        }
      }
      return String(arg);
    })
    .join(' ')
    .replace(ansiRegex, '');
}

function interceptLog(level, originalFn, ...args) {
  // 1. Output to standard terminal/stdout using original console function
  originalFn.apply(console, args);

  // 2. Format and clean message for realtime log stream
  const cleanMsg = formatMessage(args);
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    message: cleanMsg,
  };

  // 3. Store in the in-memory circular buffer
  logBuffer.push(logEntry);
  if (logBuffer.length > MAX_BUFFER_SIZE) {
    logBuffer.shift();
  }

  // 4. Emit event to all active SSE streaming clients
  logEmitter.emit('log', logEntry);
}

// Override global console methods to capture all stdout/stderr logs
console.log = (...args) => interceptLog('INFO', originalConsole.log, ...args);
console.info = (...args) => interceptLog('INFO', originalConsole.info, ...args);
console.warn = (...args) => interceptLog('WARN', originalConsole.warn, ...args);
console.error = (...args) => interceptLog('ERROR', originalConsole.error, ...args);
console.debug = (...args) => interceptLog('DEBUG', originalConsole.debug, ...args);

module.exports = {
  debug: (...args) => console.debug(...args),
  info: (...args) => console.info(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
  logEmitter,
  getRecentLogs: () => logBuffer,
};
