const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json({ limit: '50mb' }));

const MAKE_WEBHOOK = 'https://hook.eu1.make.com/mxzr6p250u98i12pxt9u8miamkla6fh7';

async function callClaude(prompt, imageBase64, mediaType) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: prompt }
      ]}]
    })
  });
  const data = await resp.json();
  if (!data.content) throw new Error('Claude failed: ' + JSON.stringify(data));
  return data.content.map(c => c.text || '').join('');
}

async function sendToMake(payload) {
  const resp = await fetch(MAKE_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return resp.ok;
}

app.get('/', (req, res) => res.json({ status: '✅ Agarwal Fabrics Bill Server Running', time: new Date().toISOString() }));

app.post('/process-bill', async (req, res) => {
  try {
    const { mode, mainImageBase64, mainMediaType, baleImageBase64, baleMediaType, sheetName, startRow } = req.body;

    console.log(`📋 Mode: ${mode}, Sheet: ${sheetName}, Row: ${startRow}`);

    let billData = {};
    let bales = [];
    const results = [];

    // ── EXTRACT MAIN BILL ──
    if (mode === 'full' || mode === 'bill') {
      console.log('📖 Reading main bill...');
      const text = await callClaude(
        'Extract from this textile/fabric tax invoice. ONLY valid JSON, no markdown:\n{"bill_date":"DD-Mon-YY","bill_no":"invoice number","party_name":"supplier company name","quality":"fabric quality e.g. 60x60-TAJ","bilty_no":"LR or bilty/way bill number","total_bales":number,"transporter":"transport company name"}',
        mainImageBase64, mainMediaType
      );
      billData = JSON.parse(text.replace(/```json|```/g,'').trim());
      console.log(`✅ Main bill: ${billData.bill_no} from ${billData.party_name}`);
    }

    // ── EXTRACT BALE SLIPS ──
    if (mode === 'full' || mode === 'bale') {
      console.log('📦 Reading bale slips...');
      const text = await callClaude(
        'Extract bale data from this handwritten bale slip. Each bale has a bale number and total meters. ONLY valid JSON, no markdown:\n{"bales":[{"bale_no":"bale number as string","meters":total meters as number},...]}\nExtract ALL bales visible. Use the TOTAL meters for each bale.',
        baleImageBase64, baleMediaType
      );
      const baleData = JSON.parse(text.replace(/```json|```/g,'').trim());
      bales = baleData.bales || [];
      console.log(`✅ Bale slips: ${bales.length} bales found`);
    }

    // ── SEND TO MAKE.COM ──
    console.log('📊 Sending to Make.com...');

    if (mode === 'bill') {
      // Bill only — send one row with bill data, no bale info
      const payload = {
        sheet_name: sheetName,
        row: parseInt(startRow),
        bill_date: billData.bill_date || '',
        bill_no: billData.bill_no || '',
        party_name: billData.party_name || '',
        quality: billData.quality || '',
        bale_no: '',
        meters: '',
        bilty_no: String(billData.bilty_no || ''),
        total_bales: String(billData.total_bales || ''),
        transporter: billData.transporter || ''
      };
      const ok = await sendToMake(payload);
      results.push({ row: parseInt(startRow), bale_no: '—', meters: '—', success: ok });

    } else if (mode === 'bale') {
      // Bale only — send each bale row with just bale info
      for (let i = 0; i < bales.length; i++) {
        const bale = bales[i];
        const row = parseInt(startRow) + i;
        const payload = {
          sheet_name: sheetName,
          row,
          bill_date: '', bill_no: '', party_name: '', quality: '',
          bale_no: String(bale.bale_no),
          meters: String(bale.meters),
          bilty_no: '', total_bales: '', transporter: ''
        };
        const ok = await sendToMake(payload);
        results.push({ row, bale_no: bale.bale_no, meters: bale.meters, success: ok });
        await new Promise(r => setTimeout(r, 500));
      }

    } else {
      // Full — send each bale with all bill info
      for (let i = 0; i < bales.length; i++) {
        const bale = bales[i];
        const row = parseInt(startRow) + i;
        const payload = {
          sheet_name: sheetName,
          row,
          bill_date: billData.bill_date || '',
          bill_no: billData.bill_no || '',
          party_name: billData.party_name || '',
          quality: billData.quality || '',
          bale_no: String(bale.bale_no),
          meters: String(bale.meters),
          bilty_no: String(billData.bilty_no || ''),
          total_bales: String(billData.total_bales || ''),
          transporter: billData.transporter || ''
        };
        const ok = await sendToMake(payload);
        results.push({ row, bale_no: bale.bale_no, meters: bale.meters, success: ok });
        await new Promise(r => setTimeout(r, 500));
      }
    }

    const pushed = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    console.log(`✅ Done: ${pushed} pushed, ${failed} failed`);

    res.json({ success: failed === 0, billData, bales, results, pushed, failed, startRow });

  } catch(err) {
    console.error('❌ Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
