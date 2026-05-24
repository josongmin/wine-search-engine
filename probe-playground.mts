import pg from 'pg';
const { Pool } = pg;
const url = (process.env['PLAYGROUND_URL'] ?? '').replace(/[?&]sslmode=[^&]*/g, '').replace(/\?$/, '');
const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
try {
  // 1. Scrape date distribution for famous wines vs overall
  const famDates = await pool.query(`
    select date_trunc('day', scraped_at)::date as d, count(*)::int as c
    from wine_pdp_snapshot
    where (display_name ilike '%sassicaia%' or display_name ilike '%opus one%' or display_name ilike '%almaviva%'
        or display_name ilike '%pétrus%' or display_name ilike '%penfolds grange%' or display_name ilike '%tignanello%'
        or display_name ilike '%château margaux%' or display_name ilike '%screaming eagle%')
    group by 1 order by 1
  `);
  console.log('Scrape dates for famous wines:');
  for (const r of famDates.rows) console.log(`  ${r.d}: ${r.c}`);

  // 2. Overall scrape date distribution (top 10 days)
  const allDates = await pool.query(`
    select date_trunc('day', scraped_at)::date as d, count(*)::int as c
    from wine_pdp_snapshot
    group by 1 order by c desc limit 10
  `);
  console.log('\nTop 10 scrape days (overall):');
  for (const r of allDates.rows) console.log(`  ${r.d}: ${r.c}`);

  // 3. min/max scraped_at
  const minMax = await pool.query(`
    select min(scraped_at) as min, max(scraped_at) as max, max(created_at) as max_created
    from wine_pdp_snapshot
  `);
  const mm = minMax.rows[0];
  console.log(`\nBronze scrape range: ${mm.min} → ${mm.max}`);
  console.log(`Bronze latest created_at: ${mm.max_created}`);
} finally { await pool.end(); }
