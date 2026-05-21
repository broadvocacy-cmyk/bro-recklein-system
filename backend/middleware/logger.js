const LEVEL = {
  200: 'INFO',
  300: 'INFO',
  400: 'WARN',
  500: 'ERROR',
};

function levelFor(status) {
  if (status >= 500) return 'ERROR';
  if (status >= 400) return 'WARN';
  return 'INFO';
}

export function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const ms   = Date.now() - start;
    const lvl  = levelFor(res.statusCode);
    const ts   = new Date().toISOString();
    console.log(`[${ts}] ${lvl} ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
  });
  next();
}
