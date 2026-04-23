const fs = require('fs');
const path = require('path');
(async () => {
  try {
    const envPath = path.resolve('.env');
    const env = fs.readFileSync(envPath, 'utf8');
    const m = env.match(/^GOOGLE_PLACES_API_KEY\s*=\s*(.*)$/m);
    const key = (m && m[1] || '').trim().replace(/^['\"]|['\"]$/g, '');
    if (!key) {
      console.error('No GOOGLE_PLACES_API_KEY found in .env');
      process.exit(1);
    }
    const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=Taj%20Bangalore&inputtype=textquery&fields=place_id&key=${key}`;
    const res = await fetch(url);
    const j = await res.json();
    console.log(JSON.stringify(j, null, 2));
  } catch (e) {
    console.error('Error:', e);
    process.exit(1);
  }
})();
