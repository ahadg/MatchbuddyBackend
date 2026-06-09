import { db } from '../db.js';

const SOURCE_URL = 'https://worldcuply.com/schedule.html';

const TEAM_CODES = {
  Algeria: 'DZA',
  Argentina: 'ARG',
  Australia: 'AUS',
  Austria: 'AUT',
  Belgium: 'BEL',
  'Bosnia and Herzegovina': 'BIH',
  Brazil: 'BRA',
  Canada: 'CAN',
  'Cape Verde': 'CPV',
  Colombia: 'COL',
  Croatia: 'CRO',
  'Curaçao': 'CUW',
  'Czech Republic': 'CZE',
  'DR Congo': 'COD',
  Ecuador: 'ECU',
  Egypt: 'EGY',
  England: 'ENG',
  France: 'FRA',
  Germany: 'GER',
  Ghana: 'GHA',
  Haiti: 'HAI',
  Iran: 'IRN',
  Iraq: 'IRQ',
  'Ivory Coast': 'CIV',
  Japan: 'JPN',
  Jordan: 'JOR',
  Mexico: 'MEX',
  Morocco: 'MAR',
  Netherlands: 'NED',
  'New Zealand': 'NZL',
  Norway: 'NOR',
  Panama: 'PAN',
  Paraguay: 'PAR',
  Portugal: 'POR',
  Qatar: 'QAT',
  'Saudi Arabia': 'KSA',
  Scotland: 'SCO',
  Senegal: 'SEN',
  'South Africa': 'RSA',
  'South Korea': 'KOR',
  Spain: 'ESP',
  Sweden: 'SWE',
  Switzerland: 'SUI',
  Tunisia: 'TUN',
  Turkey: 'TUR',
  'United States': 'USA',
  Uruguay: 'URU',
  Uzbekistan: 'UZB',
};

function stageForMatchNumber(matchNumber) {
  if (matchNumber <= 72) {
    return 'Group Stage';
  }

  if (matchNumber <= 88) {
    return 'Round of 32';
  }

  if (matchNumber <= 96) {
    return 'Round of 16';
  }

  if (matchNumber <= 100) {
    return 'Quarter-final';
  }

  if (matchNumber <= 102) {
    return 'Semi-final';
  }

  if (matchNumber === 103) {
    return 'Third-place play-off';
  }

  return 'Final';
}

function slugify(value) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parsePlaceholderCode(teamName) {
  const winnerMatch = teamName.match(/^Winner Match (\d+)$/i);

  if (winnerMatch) {
    return `W${winnerMatch[1]}`;
  }

  const loserMatch = teamName.match(/^Loser Match (\d+)$/i);

  if (loserMatch) {
    return `L${loserMatch[1]}`;
  }

  const winnerGroup = teamName.match(/^Group ([A-L]) winners$/i);

  if (winnerGroup) {
    return `1${winnerGroup[1].toUpperCase()}`;
  }

  const runnerUpGroup = teamName.match(/^Group ([A-L]) runners-up$/i);

  if (runnerUpGroup) {
    return `2${runnerUpGroup[1].toUpperCase()}`;
  }

  const thirdPlaceGroups = teamName.match(/^Group ([A-L](?:\/[A-L])*) third place$/i);

  if (thirdPlaceGroups) {
    return `3${thirdPlaceGroups[1].replace(/\//g, '')}`;
  }

  return null;
}

function teamCodeForName(teamName) {
  return TEAM_CODES[teamName] ?? parsePlaceholderCode(teamName) ?? teamName.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

function parseScheduleHtml(html) {
  const jsonMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);

  if (!jsonMatch) {
    throw new Error('Could not find the embedded schedule data.');
  }

  const data = JSON.parse(jsonMatch[1]);
  const worldCup = data['@graph'].find((item) => item['@type'] === 'SportsEvent' && Array.isArray(item.subEvent));

  if (!worldCup?.subEvent?.length) {
    throw new Error('Could not find the World Cup sub-event list.');
  }

  return worldCup.subEvent.map((event, index) => {
    const matchNumber = index + 1;
    const [homeTeam, awayTeam] = event.name.split(' vs ');

    return {
      slug: `world-cup-2026-match-${String(matchNumber).padStart(3, '0')}-${slugify(event.name)}`,
      stage: stageForMatchNumber(matchNumber),
      kickoffAt: event.startDate,
      homeCode: teamCodeForName(homeTeam),
      homeTeam,
      awayCode: teamCodeForName(awayTeam),
      awayTeam,
      venue: event.location.name,
      hostCity: event.location.address.addressLocality,
      highlight: `${stageForMatchNumber(matchNumber)} in ${event.location.address.addressLocality} at ${event.location.name}.`,
    };
  });
}

async function importWorldCupFixtures() {
  const response = await fetch(SOURCE_URL);

  if (!response.ok) {
    throw new Error(`Unable to fetch schedule source: ${response.status}`);
  }

  const html = await response.text();
  const fixtures = parseScheduleHtml(html);

  const client = await db.connect();

  try {
    await client.query('begin');

    for (const fixture of fixtures) {
      await client.query(
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
          on conflict (slug) do update
            set stage = excluded.stage,
                kickoff_at = excluded.kickoff_at,
                home_code = excluded.home_code,
                home_team = excluded.home_team,
                away_code = excluded.away_code,
                away_team = excluded.away_team,
                venue = excluded.venue,
                host_city = excluded.host_city,
                highlight = excluded.highlight
        `,
        [
          fixture.slug,
          fixture.stage,
          fixture.kickoffAt,
          fixture.homeCode,
          fixture.homeTeam,
          fixture.awayCode,
          fixture.awayTeam,
          fixture.venue,
          fixture.hostCity,
          fixture.highlight,
        ],
      );
    }

    await client.query(
      `
        update profiles
        set match_day_mode_fixture_id = case id
          when '10000000-0000-0000-0000-000000000001'::uuid then (select id from fixtures where slug = 'world-cup-2026-match-001-mexico-vs-south-africa')
          when '10000000-0000-0000-0000-000000000002'::uuid then (select id from fixtures where slug = 'world-cup-2026-match-004-united-states-vs-paraguay')
          when '10000000-0000-0000-0000-000000000003'::uuid then (select id from fixtures where slug = 'world-cup-2026-match-003-canada-vs-bosnia-and-herzegovina')
          when '10000000-0000-0000-0000-000000000004'::uuid then (select id from fixtures where slug = 'world-cup-2026-match-011-netherlands-vs-japan')
          else match_day_mode_fixture_id
        end
        where id in (
          '10000000-0000-0000-0000-000000000001'::uuid,
          '10000000-0000-0000-0000-000000000002'::uuid,
          '10000000-0000-0000-0000-000000000003'::uuid,
          '10000000-0000-0000-0000-000000000004'::uuid
        )
      `,
    );

    await client.query(
      `
        update listings
        set fixture_id = case slug
          when 'azteca-loft' then (select id from fixtures where slug = 'world-cup-2026-match-001-mexico-vs-south-africa')
          when 'queens-oled' then (select id from fixtures where slug = 'world-cup-2026-match-003-canada-vs-bosnia-and-herzegovina')
          else fixture_id
        end
        where slug in ('azteca-loft', 'queens-oled')
      `,
    );

    await client.query(
      `
        delete from fixtures
        where slug in (
          'arg-fra-semi-final',
          'eng-ger-group-f',
          'bra-esp-group-a'
        )
      `,
    );

    await client.query('commit');

    console.log(`Imported ${fixtures.length} FIFA World Cup 2026 fixtures from ${SOURCE_URL}`);
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await db.end();
  }
}

importWorldCupFixtures().catch((error) => {
  console.error(error);
  process.exit(1);
});
