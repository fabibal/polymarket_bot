// Ad-hoc: last-10 trades for dormant traders via data-api. Run in gluetun netns.
const ADDRS = {
  'Macro-Confirmed': '0x1abe1368601330a310162064e04d3c2628cb6497',
  'DrPufferfish':    '0x45c9c799e0e6ddf19c50e9dac5ab5a925f9b414b',
  'Macro-90d':       '0xd9875d4a0573dd3890738aab990938a53c360041',
};
const DATA = 'https://data-api.polymarket.com';

async function getJson(url) {
  const r = await fetch(url, { headers: { 'accept': 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

(async () => {
  for (const [label, addr] of Object.entries(ADDRS)) {
    console.log(`\n=== ${label} ${addr} ===`);
    try {
      const t = await getJson(`${DATA}/trades?user=${addr}&limit=10&takerOnly=false`);
      if (!Array.isArray(t) || t.length === 0) { console.log('  no trades returned (empty)'); continue; }
      const newest = t[0]?.timestamp;
      console.log(`  trades returned: ${t.length} | newest ts: ${newest} -> ${newest ? new Date(newest * 1000).toISOString() : '?'}`);
      const ageDays = newest ? ((Date.now() / 1000 - newest) / 86400).toFixed(1) : '?';
      console.log(`  days since last trade: ${ageDays}`);
      for (const x of t.slice(0, 10)) {
        console.log(`   ${new Date(x.timestamp * 1000).toISOString().slice(0,16)} ${x.side} ${x.outcome} @${x.price} sz=${x.size} | ${(x.title||x.slug||'').slice(0,50)}`);
      }
    } catch (e) {
      console.log('  ERROR:', e.message);
    }
  }
})();
