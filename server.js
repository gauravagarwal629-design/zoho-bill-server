const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json({ limit: '50mb' }));

const MAKE_WEBHOOK = 'https://hook.eu1.make.com/mxzr6p250u98i12pxt9u8miamkla6fh7';

function extractJSON(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  return JSON.parse(cleaned);
}

async function callClaude(prompt, imageBase64, mediaType) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6', max_tokens: 2000,
      system: 'You are a JSON extraction API. You must respond with ONLY valid JSON and absolutely nothing else - no preamble, no explanation, no markdown code fences. Your entire response must be parseable by JSON.parse().',
      messages: [
        { role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: prompt }
        ]},
        { role: 'assistant', content: '{' }
      ]
    })
  });
  const data = await resp.json();
  if (!data.content) throw new Error('Claude failed: ' + JSON.stringify(data));
  // Since we prefilled with '{', prepend it back to the response
  return '{' + data.content.map(c => c.text || '').join('');
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
      const parsed = extractJSON(text);
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
      billData = extractJSON(text);
      if (manualQuality) billData.quality = manualQuality;
      console.log(`✅ Main bill: ${billData.bill_no} from ${billData.party_name}`);
    }

    // ── BILTY EXTRACTION ──
    if (biltyImageBase64) {
      console.log('🚛 Reading bilty (this OVERRIDES bill data for transport fields)...');
      const text = await callClaude(
        'This is a photo of a physical Bilty / LR (Lorry Receipt) document issued by a transport company (could be in any orientation, even sideways or upside down - read carefully). This document is the SOURCE OF TRUTH for transport details. Extract from THIS bilty image. ONLY valid JSON, no markdown:\n{"bilty_no":"the bilty/LR/GR number - look for a field labeled No. or GR No. or similar, often a 6-digit number, sometimes preceded by a single letter like J. Extract ONLY the digits, no letter prefix, no suffix like x5","total_bales":"the number written in the No. of Packages field (could be written as a word like Five = 5)","transporter":"the transport company name from the letterhead/logo at top, e.g. Shree Ram Roadways","bale_numbers":["expand any bale number range from the Private Mark field into individual numbers. If Private Mark shows a range like 1012 TO 1016 or 1012-1016, expand to [1012,1013,1014,1015,1016]. If it shows individual numbers, list them all."]}\nThe Private Mark field is critical - it often contains handwritten bale number ranges using words like TO or a hyphen. Read this carefully even if handwriting is unclear, and expand any range fully.',
        biltyImageBase64, biltyMediaType
      );
      const biltyData = extractJSON(text);
      // Bilty data ALWAYS overrides bill data for these 3 fields
      billData.bilty_no = biltyData.bilty_no || billData.bilty_no;
      billData.total_bales = biltyData.total_bales || billData.total_bales;
      billData.transporter = biltyData.transporter || billData.transporter;
      if (biltyData.bale_numbers && biltyData.bale_numbers.length > 0) {
        bales = biltyData.bale_numbers.map(bn => ({ bale_no: String(bn), meters: '' }));
        console.log(`✅ Bale numbers from bilty: ${bales.map(b=>b.bale_no).join(', ')}`);
      }
      console.log(`✅ Bilty (overriding bill): ${billData.bilty_no}, ${billData.total_bales} bales, ${billData.transporter}`);
    }

    // ── BALE SLIPS EXTRACTION ──
    if (mode === 'full' || mode === 'bale') {
      // First bale slip photo
      if (baleImageBase64) {
        console.log('📦 Reading bale slips photo 1...');
        const text = await callClaude(
          'Extract bale data from these handwritten packing slips. The image may be rotated - handle any orientation. Each packing slip has: 1) Bale No (a 4-digit number in a box e.g. 1128, 1127, 1126) 2) Mtrs field showing TOTAL meters for that bale (e.g. 1014, 1038, 1024). ONLY use the TOTAL meters shown next to "Mtrs." - do NOT add up individual piece meters. ONLY valid JSON, no markdown:\n{"bales":[{"bale_no":"4-digit bale number","meters":total meters as number}]}\nExtract ALL bales visible regardless of image orientation.',
          baleImageBase64, baleMediaType
        );
        const data1 = extractJSON(text);
        bales = [...bales, ...(data1.bales || [])];
        console.log(`✅ Bale slip 1: ${data1.bales?.length || 0} bales`);
      }

      // Second bale slip photo (optional)
      if (bale2ImageBase64) {
        console.log('📦 Reading bale slips photo 2...');
        const text = await callClaude(
          'Extract bale data from these handwritten packing slips. The image may be rotated - handle any orientation. Each packing slip has: 1) Bale No (a 4-digit number in a box e.g. 1128, 1127, 1126) 2) Mtrs field showing TOTAL meters for that bale (e.g. 1014, 1038, 1024). ONLY use the TOTAL meters shown next to "Mtrs." - do NOT add up individual piece meters. ONLY valid JSON, no markdown:\n{"bales":[{"bale_no":"4-digit bale number","meters":total meters as number}]}\nExtract ALL bales visible regardless of image orientation.',
          bale2ImageBase64, bale2MediaType
        );
        const data2 = extractJSON(text);
        bales = [...bales, ...(data2.bales || [])];
        console.log(`✅ Bale slip 2: ${data2.bales?.length || 0} bales`);
      }
    }

    // ── SEND TO MAKE.COM ──
    console.log(`📊 Sending ${bales.length} bales to Make.com...`);
    const results = [];

    if (mode === 'bill') {
      if (bales.length > 0) {
        // Bilty gave us bale numbers - push one row per bale (meters left empty for later)
        for (let i = 0; i < bales.length; i++) {
          const bale = bales[i];
          const row = parseInt(startRow) + i;
          const ok = await sendToMake({
            sheet_name: sheetName, row,
            bill_date: billData.bill_date||'', bill_no: billData.bill_no||'',
            party_name: billData.party_name||'', quality: billData.quality||'',
            bale_no: String(bale.bale_no), meters: '',
            bilty_no: String(billData.bilty_no||''), total_bales: String(billData.total_bales||''),
            transporter: billData.transporter||''
          });
          results.push({ row, bale_no: bale.bale_no, meters: '—', success: ok });
          await new Promise(r => setTimeout(r, 500));
        }
      } else {
        // No bale numbers available - one summary row
        const ok = await sendToMake({
          sheet_name: sheetName, row: parseInt(startRow),
          bill_date: billData.bill_date||'', bill_no: billData.bill_no||'',
          party_name: billData.party_name||'', quality: billData.quality||'',
          bale_no: '', meters: '',
          bilty_no: String(billData.bilty_no||''), total_bales: String(billData.total_bales||''),
          transporter: billData.transporter||''
        });
        results.push({ row: parseInt(startRow), bale_no: '—', meters: '—', success: ok });
      }

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
