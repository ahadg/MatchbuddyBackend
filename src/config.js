import 'dotenv/config';

function readRequired(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function normalizeOrigin(value) {
  return value.trim().replace(/\/+$/, '');
}

function readOriginList(name) {
  return (process.env[name]?.split(',') ?? []).map(normalizeOrigin).filter(Boolean);
}

const supabaseSecretKey =
  process.env.SUPABASE_SECRET_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!supabaseSecretKey) {
  throw new Error('Missing required environment variable: SUPABASE_SECRET_KEY');
}

const clientOrigins = readOriginList('CLIENT_ORIGIN');
const allowAnyClientOrigin = clientOrigins.includes('*');

export const config = {
  port: Number(process.env.PORT ?? 4000),
  clientOrigins,
  allowAnyClientOrigin,
  databaseUrl: readRequired('DATABASE_URL'),
  oneSignalAppId:
    process.env.ONESIGNAL_APP_ID?.trim() || 'c6f336ef-6a24-41e0-a71c-99f439a0d440',
  oneSignalRestApiKey: process.env.ONESIGNAL_REST_API_KEY?.trim() || '',
  resendApiKey: readRequired('RESEND_API_KEY'),
  resendFromEmail: readRequired('RESEND_FROM_EMAIL'),
  resendFromName: process.env.RESEND_FROM_NAME?.trim() || 'MatchBuddy',
  supabaseProfilePhotoBucket:
    process.env.SUPABASE_PROFILE_PHOTO_BUCKET?.trim() || 'profile-photos',
  supabaseUrl: readRequired('SUPABASE_URL'),
  supabaseSecretKey,
  adminEmails: (process.env.ADMIN_EMAILS?.trim() || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
};
