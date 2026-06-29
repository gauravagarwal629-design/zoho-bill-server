const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json({ limit: '50mb' }));

const MAKE_WEBHOOK = 'https://hook.eu1.make.com/mxzr6p250u98i12pxt9u8miamkla6fh7';

app.get('/', (req, res) => res.json({ status: '✅ Agarwal Fabrics Bill Server Running', time: new Date().toISOString() }));

app.post('/process-bill', async (req, res) => {
  try {
    const { imageBase64, mediaType, sheetName, startRow } = req.body;
    if (!imageBase64 || !sheetName || !startRow) return res.status(400).json({ error: 'Missing fields' });

    // Step 1: Extract with Claude
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

    // Step 2: Send each bale to Make.com webhook
    console.log('📊 Sending to Make.com...');
    const results = [];

    for (let i = 0; i < billData.bales.length; i++) {
      const bale = billData.bales[i];
      const row = parseInt(startRow) + i;

      const payload = {
        sheet_name: sheetName,
        row: row,
        bill_date: billData.bill_date,
        bill_no: billData.bill_no,
        party_name: billData.party_name,
        quality: billData.quality,
        bale_no: String(bale.bale_no),
        meters: String(bale.meters),
        bilty_no: String(billData.bilty_no),
        total_bales: String(billData.total_bales),
        transporter: billData.transporter
      };

      console.log(`Sending row ${row}: Bale ${bale.bale_no}`);

      const webhookResp = await fetch(MAKE_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const webhookText = await webhookResp.text();
      console.log(`Webhook response [${row}]: ${webhookText}`);
      const success = webhookResp.ok;
      results.push({ row, bale_no: bale.bale_no, meters: bale.meters, success });

      await new Promise(r => setTimeout(r, 500));
    }

    const pushed = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    console.log(`✅ Done: ${pushed} sent to Make.com, ${failed} failed`);

    res.json({ success: failed === 0, billData, results, pushed, failed });

  } catch(err) {
    console.error('❌ Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
