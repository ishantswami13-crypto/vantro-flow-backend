// FILE: lib/observability/logger.js
function safeLog(level, message, metadata = {}) {
  const logData = {
    level,
    timestamp: new Date().toISOString(),
    message,
    ...metadata
  };
  const redacted = JSON.parse(JSON.stringify(logData));
  const redactKeys = ['password', 'token', 'jwt', 'cookie', 'secret', 'apikey', 'databaseurl', 'authorization', 'webhooksecret', 'servicerole'];
  function redactRecursive(obj) {
    if (!obj) return;
    for (const key in obj) {
      if (typeof obj[key] === 'object' && obj[key] !== null) redactRecursive(obj[key]);
      else if (redactKeys.some(rk => key.toLowerCase().includes(rk))) obj[key] = '[REDACTED]';
    }
  }
  redactRecursive(redacted);
  console.log(JSON.stringify(redacted));
}

module.exports = { safeLog };
