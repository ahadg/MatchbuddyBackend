import { Router } from 'express';
import { z } from 'zod';

import { db } from '../db.js';
import { requireAdmin, requireUser } from '../middleware/auth.js';

const router = Router();

const fixtureBodySchema = z.object({
  slug: z.string().trim().min(1).max(160).optional(),
  stage: z.string().trim().min(1).max(80),
  kickoffAt: z.string().datetime({ offset: true }),
  homeCode: z.string().trim().min(1).max(24),
  homeTeam: z.string().trim().min(1).max(80),
  awayCode: z.string().trim().min(1).max(24),
  awayTeam: z.string().trim().min(1).max(80),
  venue: z.string().trim().min(1).max(120),
  hostCity: z.string().trim().min(1).max(80),
  highlight: z.string().trim().min(1).max(240),
});

function mapFixtureRow(row) {
  return {
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
  };
}

function slugify(value) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);
}

function buildFixtureSlug(input) {
  if (input.slug?.trim()) {
    return slugify(input.slug);
  }

  const datePart = input.kickoffAt.slice(0, 10);
  return slugify(`${datePart}-${input.homeTeam}-v-${input.awayTeam}`);
}

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
      data: rows.map(mapFixtureRow),
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/', requireUser, requireAdmin, async (req, res, next) => {
  const parsed = fixtureBodySchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid fixture body.', details: parsed.error.flatten() });
  }

  const input = parsed.data;
  const slug = buildFixtureSlug(input);

  try {
    const { rows } = await db.query(
      `
        insert into fixtures (
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
        ) values (
          $1::text,
          $2::text,
          $3::timestamptz,
          $4::text,
          $5::text,
          $6::text,
          $7::text,
          $8::text,
          $9::text,
          $10::text
        )
        returning
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
      `,
      [
        slug,
        input.stage,
        input.kickoffAt,
        input.homeCode,
        input.homeTeam,
        input.awayCode,
        input.awayTeam,
        input.venue,
        input.hostCity,
        input.highlight,
      ],
    );

    return res.status(201).json({ data: mapFixtureRow(rows[0]) });
  } catch (error) {
    return next(error);
  }
});

router.put('/:fixtureId', requireUser, requireAdmin, async (req, res, next) => {
  const parsed = fixtureBodySchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid fixture body.', details: parsed.error.flatten() });
  }

  const input = parsed.data;
  const slug = buildFixtureSlug(input);

  try {
    const { rows } = await db.query(
      `
        update fixtures
        set slug = $2::text,
            stage = $3::text,
            kickoff_at = $4::timestamptz,
            home_code = $5::text,
            home_team = $6::text,
            away_code = $7::text,
            away_team = $8::text,
            venue = $9::text,
            host_city = $10::text,
            highlight = $11::text
        where id = $1::uuid
        returning
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
      `,
      [
        req.params.fixtureId,
        slug,
        input.stage,
        input.kickoffAt,
        input.homeCode,
        input.homeTeam,
        input.awayCode,
        input.awayTeam,
        input.venue,
        input.hostCity,
        input.highlight,
      ],
    );

    if (!rows[0]) {
      return res.status(404).json({ error: 'Fixture not found.' });
    }

    return res.json({ data: mapFixtureRow(rows[0]) });
  } catch (error) {
    return next(error);
  }
});

export default router;
