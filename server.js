const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json({ limit: '50mb' }));

const CLIENT_ID     = '1000.4HPPM4ZWIIFSETGTSVWOU7J8DBRHDV';
const CLIENT_SECRET = '59142906ff3f3fbc622efe24411bb9be60f80a1955';
const REFRESH_TOKEN = '1000.0960e26f79ead54a3543404063f084e1.6929ff664cc9af1fc3b0bf6504e3b6fc';
const WORKBOOK_ID   = 'qe7xuf60bcd84eb7143c6b6e856d16a69d152';
const GEMINI_KEY    = process.env.GEMINI_API_KEY;

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const resp = await fetch('https://accounts.zoho.in/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: REFRESH_TOKEN, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'refresh_token' }).toString()
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('Token refresh failed: ' + JSON.stringify(data));
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + 55 * 60 * 1000;
  console.log('✅ Zoho token refreshed');
  return cachedToken;
}

async function writeToZoho(token, sheetName, row, col, csv) {
  const body = new URLSearchParams({ method: 'worksheet.range.write', worksheet_name: sheetName, start_row: String(row), start_column: String(col), data: csv });
  const resp = await fetch(`https://sheet.zoho.in/api/v2/${WORKBOOK_ID}`, {
    method: 'POST',
    headers: { 'Authorization': `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const json = await resp.json();
  console.log(`Row ${row} col ${col}:`, json.status);
  return json;
}

async function extractWithGemini(imageBase64, mediaType) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;
  const prompt = 'Extract from this textile/fabric bill. ONLY valid JSON, no markdown, no explanation:\n{"bill_date":"DD-Mon-YY e.g. 23-Jun-26","bill_no":"invoice number","party_name":"supplier name","quality":"fabric quality e.g. 60x60-TAJ","bilty_no":"LR or bilty number","total_bales":number,"transporter":"transport company name","bales":[{"bale_no":"bale number","meters":number}]}\nExtract ALL bales listed.';

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [
        { inline_data: { mime_type: mediaType || 'image/jpeg', data: imageBase64 } },
        { text: prompt }
      ]}]
    })
  });

  const data = await resp.json();
  console.log('Gemini response:', JSON.stringify(data).substring(0, 200));
  
  if (!data.candidates || !data.candidates[0]) throw new Error('Gemini failed: ' + JSON.stringify(data));
  
  const text = data.candidates[0].content.parts.map(p => p.text || '').join('');
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

app.get('/', (req, res) => res.json({ status: '✅ Agarwal Fabrics Bill Server Running', time: new Date().toISOString() }));

app.post('/process-bill', async (req, res) => {
  try {
    const { imageBase64, mediaType, sheetName, startRow } = req.body;
    if (!imageBase64 || !sheetName || !startRow) return res.status(400).json({ error: 'Missing fields' });

    console.log('📖 Extracting bill with Gemini...');
    const billData = await extractWithGemini(imageBase64, mediaType);
    console.log(`✅ Extracted ${billData.bales.length} bales`);

    console.log('📊 Pushing to Zoho...');
    const token = await getAccessToken();
    const results = [];

    for (let i = 0; i < billData.bales.length; i++) {
      const bale = billData.bales[i];
      const row = startRow + i;
      const csv1 = [billData.bill_date, billData.bill_no, billData.party_name, billData.quality, bale.bale_no, bale.meters].join(',');
      const csv2 = [billData.bilty_no, billData.total_bales, billData.transporter].join(',');
      const r1 = await writeToZoho(token, sheetName, row, 8, csv1);
      const r2 = await writeToZoho(token, sheetName, row, 18, csv2);
      results.push({ row, bale_no: bale.bale_no, meters: bale.meters, success: r1.status === 'success' && r2.status === 'success' });
      await new Promise(r => setTimeout(r, 300));
    }

    res.json({ success: true, billData, results, pushed: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length });
  } catch(err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
