import { Router } from 'express';
import { z } from 'zod';

import { fetchNotificationsForProfile, markAllNotificationsRead } from '../lib/notifications.js';
import { getCurrentProfileByAuthUserId } from '../lib/social.js';
import { requireUser } from '../middleware/auth.js';

const router = Router();

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

router.use(requireUser);

router.get('/', async (req, res, next) => {
  const parsed = querySchema.safeParse(req.query);

  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid notifications query.', details: parsed.error.flatten() });
  }

  try {
    const currentProfile = await getCurrentProfileByAuthUserId(req.authUser.id);

    if (!currentProfile) {
      return res.status(403).json({ error: 'Create your profile before opening notifications.' });
    }

    const feed = await fetchNotificationsForProfile(currentProfile.id, parsed.data);

    return res.json({ data: feed });
  } catch (error) {
    return next(error);
  }
});

router.post('/read-all', async (req, res, next) => {
  try {
    const currentProfile = await getCurrentProfileByAuthUserId(req.authUser.id);

    if (!currentProfile) {
      return res.status(403).json({ error: 'Create your profile before updating notifications.' });
    }

    await markAllNotificationsRead(currentProfile.id);

    return res.json({ data: { success: true } });
  } catch (error) {
    return next(error);
  }
});

export default router;
