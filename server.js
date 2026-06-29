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

let cachedToken = null;
let tokenExpiry = 0;

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
  tokenExpiry = Date.now() + 55 * 60 * 1000;
  console.log('✅ Zoho token refreshed');
  return cachedToken;
}

async function writeRowToZoho(token, sheetName, row, billData, bale) {
  // Build cell_data array for all columns in one API call
  const cellData = [
    { row_index: row, column_index: 8,  value: String(billData.bill_date || '') },
    { row_index: row, column_index: 9,  value: String(billData.bill_no || '') },
    { row_index: row, column_index: 10, value: String(billData.party_name || '') },
    { row_index: row, column_index: 11, value: String(billData.quality || '') },
    { row_index: row, column_index: 12, value: String(bale.bale_no || '') },
    { row_index: row, column_index: 13, value: String(bale.meters || '') },
    { row_index: row, column_index: 18, value: String(billData.bilty_no || '') },
    { row_index: row, column_index: 19, value: String(billData.total_bales || '') },
    { row_index: row, column_index: 20, value: String(billData.transporter || '') }
  ];

  const body = new URLSearchParams({
    method: 'worksheet.cell.update',
    worksheet_name: sheetName,
    cell_data: JSON.stringify(cellData)
  });

  const resp = await fetch(`https://sheet.zoho.in/api/v2/${WORKBOOK_ID}`, {
    method: 'POST',
    headers: {
      'Authorization': `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });

  const text = await resp.text();
  console.log(`Row ${row} response: ${text.substring(0, 150)}`);
  
  try {
    const json = JSON.parse(text);
    return json.status === 'success';
  } catch(e) {
    return false;
  }
}

app.get('/', (req, res) => res.json({ status: '✅ Agarwal Fabrics Bill Server Running', time: new Date().toISOString() }));

app.post('/process-bill', async (req, res) => {
  try {
    const { imageBase64, mediaType, sheetName, startRow } = req.body;
    if (!imageBase64 || !sheetName || !startRow) return res.status(400).json({ error: 'Missing fields' });

    console.log('📖 Extracting bill with Claude...');
    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: 'Extract from this textile/fabric bill. ONLY valid JSON, no markdown:\n{"bill_date":"DD-Mon-YY","bill_no":"invoice number","party_name":"supplier name","quality":"fabric quality e.g. 60x60-TAJ","bilty_no":"LR or bilty number","total_bales":number,"transporter":"transport company name","bales":[{"bale_no":"bale number","meters":number}]}\nExtract ALL bales.' }
        ]}]
      })
    });

    const aiData = await aiResp.json();
    if (!aiData.content) throw new Error('Claude failed: ' + JSON.stringify(aiData));
    const text = aiData.content.map(c => c.text || '').join('');
    const billData = JSON.parse(text.replace(/```json|```/g, '').trim());
    console.log(`✅ Extracted ${billData.bales.length} bales from bill ${billData.bill_no}`);

    console.log('📊 Pushing to Zoho Sheet...');
    const token = await getAccessToken();
    const results = [];

    for (let i = 0; i < billData.bales.length; i++) {
      const bale = billData.bales[i];
      const row = parseInt(startRow) + i;
      console.log(`Writing row ${row}: Bale ${bale.bale_no}`);
      const success = await writeRowToZoho(token, sheetName, row, billData, bale);
      results.push({ row, bale_no: bale.bale_no, meters: bale.meters, success });
      await new Promise(r => setTimeout(r, 500));
    }

    const pushed = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    console.log(`✅ Done: ${pushed} pushed, ${failed} failed`);

    res.json({ success: failed === 0, billData, results, pushed, failed });

  } catch(err) {
    console.error('❌ Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
