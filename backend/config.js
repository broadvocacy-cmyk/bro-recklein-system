const REQUIRED = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ANTHROPIC_API_KEY'
];

const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`[config] Missing required env vars: ${missing.join(', ')}`);
  console.error('[config] Copy config/env.example to .env and fill in the values.');
  process.exit(1);
}

export const config = {
  port:            parseInt(process.env.PORT || '3000', 10),
  nodeEnv:         process.env.NODE_ENV || 'development',
  isProd:          process.env.NODE_ENV === 'production',
  corsOrigin:      process.env.CORS_ORIGIN || '*',
  logLevel:        process.env.LOG_LEVEL || 'info',
  primaryPersonId: process.env.PRIMARY_PERSON_ID || null,
};
