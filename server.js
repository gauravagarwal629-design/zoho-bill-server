const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

// ── CONFIG ──
const CLIENT_ID     = '1000.4HPPM4ZWIIFSETGTSVWOU7J8DBRHDV';
const CLIENT_SECRET = '59142906ff3f3fbc622efe24411bb9be60f80a1955';
const REFRESH_TOKEN = '1000.0960e26f79ead54a3543404063f084e1.6929ff664cc9af1fc3b0bf6504e3b6fc';
const WORKBOOK_ID   = 'qe7xuf60bcd84eb7143c6b6e856d16a69d152';

let cachedToken = null;
let tokenExpiry = 0;

// ── AUTO REFRESH TOKEN ──
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const resp = await fetch('https://accounts.zoho.in/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: REFRESH_TOKEN,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token'
    }).toString()
  });

  const data = await resp.json();
  if (!data.access_token) throw new Error('Token refresh failed: ' + JSON.stringify(data));

  cachedToken = data.access_token;
  tokenExpiry = Date.now() + 55 * 60 * 1000; // 55 min cache
  console.log('✅ Token refreshed at', new Date().toLocaleTimeString());
  return cachedToken;
}

// ── WRITE TO ZOHO SHEET ──
async function writeToZoho(token, sheetName, row, col, csv) {
  const body = new URLSearchParams({
    method: 'worksheet.range.write',
    worksheet_name: sheetName,
    start_row: String(row),
    start_column: String(col),
    data: csv
  });

  const resp = await fetch(`https://sheet.zoho.in/api/v2/${WORKBOOK_ID}`, {
    method: 'POST',
    headers: {
      'Authorization': `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });

  const json = await resp.json();
  return json;
}

// ── HEALTH CHECK ──
app.get('/', (req, res) => res.json({ status: '✅ Agarwal Fabrics Bill Server Running' }));

// ── MAIN PUSH ENDPOINT ──
app.post('/push-bill', async (req, res) => {
  try {
    const { sheetName, startRow, billData } = req.body;

    if (!sheetName || !startRow || !billData) {
      return res.status(400).json({ error: 'Missing sheetName, startRow or billData' });
    }

    const token = await getAccessToken();
    const results = [];

    for (let i = 0; i < billData.bales.length; i++) {
      const bale = billData.bales[i];
      const row = startRow + i;

      // H(8) to M(13): Bill Date, Bill No, Party, Quality, Bale No, Meters
      const csv1 = [
        billData.bill_date, billData.bill_no, billData.party_name,
        billData.quality, bale.bale_no, bale.meters
      ].join(',');

      // R(18) to T(20): Bilty No, Total Bales, Transporter
      const csv2 = [
        billData.bilty_no, billData.total_bales, billData.transporter
      ].join(',');

      const r1 = await writeToZoho(token, sheetName, row, 8, csv1);
      const r2 = await writeToZoho(token, sheetName, row, 18, csv2);

      results.push({
        row,
        bale_no: bale.bale_no,
        meters: bale.meters,
        success: r1.status === 'success' && r2.status === 'success'
      });

      await new Promise(r => setTimeout(r, 300)); // rate limit
    }

    const allOk = results.every(r => r.success);
    res.json({ success: allOk, results, pushed: results.filter(r=>r.success).length, failed: results.filter(r=>!r.success).length });

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
