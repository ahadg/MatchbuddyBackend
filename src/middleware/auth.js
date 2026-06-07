import { supabaseAdmin } from '../supabase.js';

function readBearerToken(authorizationHeader) {
  if (!authorizationHeader) {
    return null;
  }

  const [scheme, token] = authorizationHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return null;
  }

  return token.trim();
}

export async function optionalAuth(req, res, next) {
  const token = readBearerToken(req.headers.authorization);

  if (!token) {
    req.authUser = null;
    return next();
  }

  const {
    data: { user },
    error,
  } = await supabaseAdmin.auth.getUser(token);

  if (error || !user) {
    return res.status(401).json({ error: 'Invalid Supabase access token.' });
  }

  req.authUser = user;
  return next();
}

export function requireUser(req, res, next) {
  if (!req.authUser) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  return next();
}
