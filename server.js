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
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001', max_tokens: 2000,
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
    const { mode, mainImageBase64, mainMediaType, baleImageBase64, baleMediaType,
            bale2ImageBase64, bale2MediaType, biltyImageBase64, biltyMediaType,
            sheetName, startRow, quality: manualQuality } = req.body;

    console.log(`📋 Mode: ${mode}, Sheet: ${sheetName}, Row: ${startRow}`);

    let billData = {};
    let bales = [];

    // ── COMPLETE BILL MODE (Nikita type - everything in one bill) ──
    if (mode === 'complete') {
      console.log('📋 Reading complete bill (all details in one)...');
      const text = await callClaude(
        'Extract ALL data from this textile/fabric bill which contains bale-wise details. ONLY valid JSON, no markdown:\n{"bill_date":"DD-Mon-YY","bill_no":"invoice number","party_name":"supplier name","quality":"fabric quality","bilty_no":"LR/bilty/way bill number","total_bales":number,"transporter":"transport company","bales":[{"bale_no":"bale number","meters":total meters for this bale as number}]}\nExtract ALL bales listed with their individual meters.',
        mainImageBase64, mainMediaType
      );
      const parsed = JSON.parse(text.replace(/```json|```/g,'').trim());
      billData = parsed;
      bales = parsed.bales || [];
      if (manualQuality) billData.quality = manualQuality;
      console.log(`✅ Complete bill: ${billData.bill_no}, ${bales.length} bales`);
    }

    // ── MAIN BILL EXTRACTION ──
    if (mode === 'full' || mode === 'bill') {
      console.log('📄 Reading main bill...');
      const text = await callClaude(
        'Extract from this textile/fabric tax invoice. ONLY valid JSON, no markdown:\n{"bill_date":"DD-Mon-YY","bill_no":"invoice number","party_name":"supplier company name","quality":"fabric quality e.g. 60x60-TAJ","bilty_no":"LR or bilty/way bill number","total_bales":number,"transporter":"transport company name"}',
        mainImageBase64, mainMediaType
      );
      billData = JSON.parse(text.replace(/```json|```/g,'').trim());
      if (manualQuality) billData.quality = manualQuality;
      console.log(`✅ Main bill: ${billData.bill_no} from ${billData.party_name}`);
    }

    // ── BILTY EXTRACTION ──
    if (biltyImageBase64) {
      console.log('🚛 Reading bilty...');
      const text = await callClaude(
        'Extract transport details from this bilty/LR (Lorry Receipt). ONLY valid JSON, no markdown:\n{"bilty_no":"the LR/bilty number","total_bales":number of packages/bales,"transporter":"transport company name from letterhead"}',
        biltyImageBase64, biltyMediaType
      );
      const biltyData = JSON.parse(text.replace(/```json|```/g,'').trim());
      if (biltyData.bilty_no) billData.bilty_no = biltyData.bilty_no;
      if (biltyData.total_bales) billData.total_bales = biltyData.total_bales;
      if (biltyData.transporter) billData.transporter = biltyData.transporter;
      console.log(`✅ Bilty: ${billData.bilty_no}, ${billData.total_bales} bales, ${billData.transporter}`);
    }

    // ── BALE SLIPS EXTRACTION ──
    if (mode === 'full' || mode === 'bale') {
      // First bale slip photo
      if (baleImageBase64) {
        console.log('📦 Reading bale slips photo 1...');
        const text = await callClaude(
          'Extract bale data from these handwritten packing slips. Each slip has Bale No (number in box at top) and Mtrs (TOTAL meters next to "Mtrs." at top - NOT individual piece meters below). ONLY valid JSON, no markdown:\n{"bales":[{"bale_no":"bale number","meters":total meters as number}]}\nExtract ALL bales. Use TOTAL meters from top of each slip.',
          baleImageBase64, baleMediaType
        );
        const data1 = JSON.parse(text.replace(/```json|```/g,'').trim());
        bales = [...bales, ...(data1.bales || [])];
        console.log(`✅ Bale slip 1: ${data1.bales?.length || 0} bales`);
      }

      // Second bale slip photo (optional)
      if (bale2ImageBase64) {
        console.log('📦 Reading bale slips photo 2...');
        const text = await callClaude(
          'Extract bale data from these handwritten packing slips. Each slip has Bale No (number in box at top) and Mtrs (TOTAL meters next to "Mtrs." at top - NOT individual piece meters below). ONLY valid JSON, no markdown:\n{"bales":[{"bale_no":"bale number","meters":total meters as number}]}\nExtract ALL bales. Use TOTAL meters from top of each slip.',
          bale2ImageBase64, bale2MediaType
        );
        const data2 = JSON.parse(text.replace(/```json|```/g,'').trim());
        bales = [...bales, ...(data2.bales || [])];
        console.log(`✅ Bale slip 2: ${data2.bales?.length || 0} bales`);
      }
    }

    // ── SEND TO MAKE.COM ──
    console.log(`📊 Sending ${bales.length} bales to Make.com...`);
    const results = [];

    if (mode === 'bill') {
      // Bill only - one row, no bale details
      const ok = await sendToMake({
        sheet_name: sheetName, row: parseInt(startRow),
        bill_date: billData.bill_date||'', bill_no: billData.bill_no||'',
        party_name: billData.party_name||'', quality: billData.quality||'',
        bale_no: '', meters: '',
        bilty_no: String(billData.bilty_no||''), total_bales: String(billData.total_bales||''),
        transporter: billData.transporter||''
      });
      results.push({ row: parseInt(startRow), bale_no: '—', meters: '—', success: ok });

    } else if (mode === 'bale') {
      // Bale only - just bale details
      for (let i = 0; i < bales.length; i++) {
        const bale = bales[i];
        const row = parseInt(startRow) + i;
        const ok = await sendToMake({
          sheet_name: sheetName, row,
          bill_date: '', bill_no: '', party_name: '', quality: '',
          bale_no: String(bale.bale_no), meters: String(bale.meters),
          bilty_no: '', total_bales: '', transporter: ''
        });
        results.push({ row, bale_no: bale.bale_no, meters: bale.meters, success: ok });
        await new Promise(r => setTimeout(r, 500));
      }

    } else {
      // Complete or Full - all details per bale
      for (let i = 0; i < bales.length; i++) {
        const bale = bales[i];
        const row = parseInt(startRow) + i;
        const ok = await sendToMake({
          sheet_name: sheetName, row,
          bill_date: billData.bill_date||'', bill_no: billData.bill_no||'',
          party_name: billData.party_name||'', quality: billData.quality||'',
          bale_no: String(bale.bale_no), meters: String(bale.meters),
          bilty_no: String(billData.bilty_no||''), total_bales: String(billData.total_bales||''),
          transporter: billData.transporter||''
        });
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
