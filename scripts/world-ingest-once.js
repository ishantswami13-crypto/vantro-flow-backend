// One-off manual invocation of both vertical-slice ingestion sources, for
// proving Phase 1 works against real data outside the cron schedule.
require('dotenv').config();
(async () => {
  const usgs = require('../lib/world/sources/usgsEarthquakes');
  const fx = require('../lib/world/sources/fxRates');
  const which = process.argv[2];
  try {
    if (!which || which === 'usgs') {
      const r1 = await usgs.ingest();
      console.log('USGS result:', r1.stats);
    }
    if (!which || which === 'fx') {
      const r2 = await fx.ingest();
      console.log('FX result:', r2.stats);
    }
  } catch (e) {
    console.error('Ingestion failed:', e.message);
    process.exitCode = 1;
  }
  process.exit(0);
})();
