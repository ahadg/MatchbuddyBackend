import { Router } from 'express';

import { db } from '../db.js';

const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      `
        select
          id,
          slug,
          stage,
          kickoff_at,
          home_code,
          home_team,
          away_code,
          away_team,
          venue,
          host_city,
          highlight
        from fixtures
        order by kickoff_at asc
      `,
    );

    return res.json({
      data: rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        stage: row.stage,
        kickoffAt: row.kickoff_at,
        homeCode: row.home_code,
        homeTeam: row.home_team,
        awayCode: row.away_code,
        awayTeam: row.away_team,
        venue: row.venue,
        hostCity: row.host_city,
        highlight: row.highlight,
      })),
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
