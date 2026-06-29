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
  console.log('✅ Token refreshed');
  return cachedToken;
}

// Use REST endpoint style - set cell content via range
async function setCellContent(token, sheetName, row, col, value) {
  // Convert column number to letter (8=H, 9=I etc)
  const colLetter = String.fromCharCode(64 + col);
  const range = `${colLetter}${row}`;
  
  const url = `https://sheet.zoho.in/api/v2/${WORKBOOK_ID}`;
  const body = new URLSearchParams({
    method: 'worksheet.cell.content.set',
    worksheet_name: sheetName,
    cell_index: range,
    content: String(value)
  });

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });
  const text = await resp.text();
  console.log(`Set ${range}="${value}": ${text.substring(0,100)}`);
  try { return JSON.parse(text); } catch(e) { return { status: 'error', raw: text }; }
}

app.get('/', (req, res) => res.json({ status: '✅ Agarwal Fabrics Bill Server Running', time: new Date().toISOString() }));

// Test endpoint - try different methods
app.get('/test-zoho', async (req, res) => {
  try {
    const token = await getAccessToken();
    const results = {};
    
    // Try method 1: worksheet.cell.content.set
    const methods = [
      'worksheet.cell.content.set',
      'worksheet.range.read',
      'worksheet.cell.content.get',
      'workbook.worksheets.list'
    ];
    
    for (const method of methods) {
      const url = `https://sheet.zoho.in/api/v2/${WORKBOOK_ID}`;
      const body = new URLSearchParams({
        method,
        worksheet_name: '60x60',
        cell_index: 'A1'
      });
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });
      const text = await resp.text();
      results[method] = text.substring(0, 100);
    }
    
    res.json(results);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

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
    console.log(`✅ Extracted ${billData.bales.length} bales from ${billData.bill_no}`);

    const token = await getAccessToken();
    const results = [];

    for (let i = 0; i < billData.bales.length; i++) {
      const bale = billData.bales[i];
      const row = parseInt(startRow) + i;

      // Write each cell individually
      const cells = [
        { col: 8,  val: billData.bill_date },
        { col: 9,  val: billData.bill_no },
        { col: 10, val: billData.party_name },
        { col: 11, val: billData.quality },
        { col: 12, val: bale.bale_no },
        { col: 13, val: bale.meters },
        { col: 18, val: billData.bilty_no },
        { col: 19, val: billData.total_bales },
        { col: 20, val: billData.transporter }
      ];

      let rowSuccess = true;
      for (const cell of cells) {
        const r = await setCellContent(token, sheetName, row, cell.col, cell.val);
        if (r.status !== 'success') rowSuccess = false;
        await new Promise(res => setTimeout(res, 200));
      }

      results.push({ row, bale_no: bale.bale_no, meters: bale.meters, success: rowSuccess });
    }

    const pushed = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    console.log(`Done: ${pushed} pushed, ${failed} failed`);

    res.json({ success: failed === 0, billData, results, pushed, failed });

  } catch(err) {
    console.error('❌ Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
