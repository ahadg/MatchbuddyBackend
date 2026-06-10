import 'dotenv/config';

function readRequired(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

const supabaseSecretKey =
  process.env.SUPABASE_SECRET_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!supabaseSecretKey) {
  throw new Error('Missing required environment variable: SUPABASE_SECRET_KEY');
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  clientOrigin: process.env.CLIENT_ORIGIN?.trim() || '*',
  databaseUrl: readRequired('DATABASE_URL'),
  resendApiKey: readRequired('RESEND_API_KEY'),
  resendFromEmail: readRequired('RESEND_FROM_EMAIL'),
  resendFromName: process.env.RESEND_FROM_NAME?.trim() || 'MatchBuddy',
  supabaseUrl: readRequired('SUPABASE_URL'),
  supabaseSecretKey,
  adminEmails: (process.env.ADMIN_EMAILS?.trim() || 'muhmmadahad594@gmail.com')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
};
