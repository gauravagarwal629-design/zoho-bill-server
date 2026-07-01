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

// FIX #2: Bilty numbers sometimes come back with trailing junk like "664436x5"
// (copy-count markers, stray characters near the No. field on the physical slip).
// Instead of trusting the model's formatting, pull out the first run of digits only.
function cleanDigitsOnly(val) {
  if (val === undefined || val === null) return val;
  const match = String(val).match(/\d+/);
  return match ? match[0] : String(val).trim();
}

// FIX #3: Don't rely solely on Claude to expand "1012 TO 1016" into individual bale
// numbers. If it already expanded them (numbers/strings with no range marker), this
// is a no-op. If it returned the raw range text instead, we expand it here.
function expandBaleNumbers(rawList) {
  if (!Array.isArray(rawList)) return [];
  const expanded = [];
  for (const item of rawList) {
    const str = String(item).trim();
    const rangeMatch = str.match(/(\d+)\s*(?:TO|to|-|–)\s*(\d+)/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (!isNaN(start) && !isNaN(end) && end >= start && (end - start) < 500) {
        for (let n = start; n <= end; n++) expanded.push(n);
        continue;
      }
    }
    const digitsOnly = str.match(/\d+/);
    if (digitsOnly) expanded.push(digitsOnly[0]);
  }
  return expanded;
}

// FIX #1 (rewritten): Claude 4.6+ models REJECT assistant-turn prefill outright
// ("This model does not support assistant message prefill"). The old '{' prefill
// trick is dead. The correct, GA replacement is Structured Outputs: pass a JSON
// Schema via output_config.format and the API grammar-constrains the response to
// match it exactly - no preamble, no markdown fences, no regex cleanup needed.
// This also strengthens Issue #3: because bale_numbers is typed as an array of
// numbers, Claude physically cannot emit a raw string like "1012 TO 1016" in that
// slot - it must emit individual numeric items.
// ── JSON Schemas for structured outputs (replaces old prefill approach) ──
const completeBillSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    bill_date: { type: 'string', description: 'DD-Mon-YY' },
    bill_no: { type: 'string' },
    party_name: { type: 'string' },
    quality: { type: 'string' },
    bilty_no: { type: 'string' },
    total_bales: { type: 'number' },
    transporter: { type: 'string' },
    bales: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bale_no: { type: 'string' },
          meters: { type: 'number' }
        },
        required: ['bale_no', 'meters']
      }
    }
  },
  required: ['bill_date', 'bill_no', 'party_name', 'quality', 'bilty_no', 'total_bales', 'transporter', 'bales']
};

const mainBillSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    bill_date: { type: 'string', description: 'DD-Mon-YY' },
    bill_no: { type: 'string' },
    party_name: { type: 'string' },
    quality: { type: 'string' },
    bilty_no: { type: 'string' },
    total_bales: { type: 'number' },
    transporter: { type: 'string' }
  },
  required: ['bill_date', 'bill_no', 'party_name', 'quality', 'bilty_no', 'total_bales', 'transporter']
};

const biltySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    bilty_no: { type: 'string', description: 'Digits only, no letter prefix, no suffix' },
    total_bales: { type: 'string' },
    transporter: { type: 'string' },
    bale_numbers: {
      type: 'array',
      items: { type: 'number' },
      description: 'Every individual bale number from the Private Mark field, with any range fully expanded'
    }
  },
  required: ['bilty_no', 'total_bales', 'transporter', 'bale_numbers']
};

const baleSlipSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    bales: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bale_no: { type: 'string' },
          meters: { type: 'number' }
        },
        required: ['bale_no', 'meters']
      }
    }
  },
  required: ['bales']
};


async function callClaude(prompt, imageBase64, mediaType, schema) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6', max_tokens: 2000,
      system: 'You are a precise document data extraction API for textile/fabric trade documents.',
      messages: [
        { role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: prompt }
        ]}
      ],
      output_config: {
        format: { type: 'json_schema', schema }
      }
    })
  });
  const data = await resp.json();
  if (!data.content) throw new Error('Claude failed: ' + JSON.stringify(data));
  const textBlock = data.content.find(c => c.type === 'text');
  if (!textBlock) throw new Error('Claude returned no text block: ' + JSON.stringify(data));
  return textBlock.text;
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
        'Extract ALL data from this textile/fabric bill which contains bale-wise details, including bill_date, bill_no (invoice number), party_name (supplier name), quality (fabric quality), bilty_no (LR/bilty/way bill number), total_bales, transporter, and the full list of bales with their individual meters.',
        mainImageBase64, mainMediaType, completeBillSchema
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
        'Extract from this textile/fabric tax invoice: bill_date, bill_no (invoice number), party_name (supplier company name), quality (fabric quality e.g. 60x60-TAJ), bilty_no (LR or bilty/way bill number), total_bales, transporter (transport company name).',
        mainImageBase64, mainMediaType, mainBillSchema
      );
      billData = extractJSON(text);
      if (manualQuality) billData.quality = manualQuality;
      console.log(`✅ Main bill: ${billData.bill_no} from ${billData.party_name}`);
    }

    // ── BILTY EXTRACTION ──
    if (biltyImageBase64) {
      console.log('🚛 Reading bilty (this OVERRIDES bill data for transport fields)...');
      const text = await callClaude(
        'This is a photo of a physical Bilty / LR (Lorry Receipt) document issued by a transport company (could be in any orientation, even sideways or upside down - read carefully). This document is the SOURCE OF TRUTH for transport details. Extract: bilty_no (the bilty/LR/GR number - look for a field labeled No. or GR No. or similar, often a 6-digit number, sometimes preceded by a single letter like J - extract ONLY the digits, no letter prefix, no suffix), total_bales (the number written in the No. of Packages field, could be written as a word like Five = 5), transporter (the transport company name from the letterhead/logo at top, e.g. Shree Ram Roadways), and bale_numbers (every individual bale number from the Private Mark field - it often contains a handwritten range like "1012 TO 1016" or "1012-1016", which must be expanded into every individual number 1012,1013,1014,1015,1016 as separate array items, not left as a range).',
        biltyImageBase64, biltyMediaType, biltySchema
      );
      const biltyData = extractJSON(text);

      // FIX #2: strip trailing junk (e.g. "664436x5" -> "664436") before it ever reaches the sheet
      const cleanedBiltyNo = cleanDigitsOnly(biltyData.bilty_no);

      // Bilty data ALWAYS overrides bill data for these 3 fields
      billData.bilty_no = cleanedBiltyNo || billData.bilty_no;
      billData.total_bales = biltyData.total_bales || billData.total_bales;
      billData.transporter = biltyData.transporter || billData.transporter;

      // FIX #3: guarantee ranges get expanded even if Claude didn't do it in the response
      if (biltyData.bale_numbers && biltyData.bale_numbers.length > 0) {
        const expandedNumbers = expandBaleNumbers(biltyData.bale_numbers);

        if (bales.length > 0 && bales.length === expandedNumbers.length) {
          // We already have bale data (with meters) from a complete-bill or bale-slip pass.
          // Private Mark numbers are more reliable for numbering, so swap in the numbers
          // but KEEP the meters we already have - don't discard them.
          bales = bales.map((b, i) => ({ bale_no: String(expandedNumbers[i]), meters: b.meters }));
        } else if (bales.length === 0) {
          // No bale data yet - use bilty numbers, meters to be filled in by a later bale-slip pass
          bales = expandedNumbers.map(bn => ({ bale_no: String(bn), meters: '' }));
        } else {
          // Counts don't match existing bale data - keep what we have rather than risk
          // clobbering good data with a mismatched set.
          console.log(`⚠️ Bilty gave ${expandedNumbers.length} bale numbers but ${bales.length} bales already loaded - keeping existing bale data`);
        }
        console.log(`✅ Bale numbers from bilty: ${expandedNumbers.join(', ')}`);
      }
      console.log(`✅ Bilty (overriding bill): ${billData.bilty_no}, ${billData.total_bales} bales, ${billData.transporter}`);
    }

    // ── BALE SLIPS EXTRACTION ──
    if (mode === 'full' || mode === 'bale') {
      // First bale slip photo
      if (baleImageBase64) {
        console.log('📦 Reading bale slips photo 1...');
        const text = await callClaude(
          'Extract bale data from these handwritten packing slips. The image may be rotated - handle any orientation. Each packing slip has: 1) Bale No (a 4-digit number in a box e.g. 1128, 1127, 1126) 2) Mtrs field showing TOTAL meters for that bale (e.g. 1014, 1038, 1024). ONLY use the TOTAL meters shown next to "Mtrs." - do NOT add up individual piece meters. Extract ALL bales visible regardless of image orientation.',
          baleImageBase64, baleMediaType, baleSlipSchema
        );
        const data1 = extractJSON(text);
        bales = [...bales, ...(data1.bales || [])];
        console.log(`✅ Bale slip 1: ${data1.bales?.length || 0} bales`);
      }

      // Second bale slip photo (optional)
      if (bale2ImageBase64) {
        console.log('📦 Reading bale slips photo 2...');
        const text = await callClaude(
          'Extract bale data from these handwritten packing slips. The image may be rotated - handle any orientation. Each packing slip has: 1) Bale No (a 4-digit number in a box e.g. 1128, 1127, 1126) 2) Mtrs field showing TOTAL meters for that bale (e.g. 1014, 1038, 1024). ONLY use the TOTAL meters shown next to "Mtrs." - do NOT add up individual piece meters. Extract ALL bales visible regardless of image orientation.',
          bale2ImageBase64, bale2MediaType, baleSlipSchema
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
      // FIX #4: Bale-only mode must NOT send blank values for bill-level fields.
      // Previously this sent bill_date:'', bill_no:'', etc. which, depending on how
      // the Make.com "Update Row" module maps fields, can overwrite existing bill data
      // already sitting in that row with blanks. We now omit those keys entirely so
      // only bale_no/meters/row/sheet_name are in the payload.
      // NOTE: this alone only fixes the server side. Open your Make.com scenario's
      // Zoho Sheets "Update Row" module and make sure bill_date/bill_no/party_name/
      // quality/bilty_no/total_bales/transporter are NOT force-mapped to a blank
      // variable when the key is missing - unmap them, or use a fallback/"keep
      // existing value" expression for each, otherwise Make may still write blanks.
      for (let i = 0; i < bales.length; i++) {
        const bale = bales[i];
        const row = parseInt(startRow) + i;
        const ok = await sendToMake({
          sheet_name: sheetName, row,
          bale_no: String(bale.bale_no), meters: String(bale.meters)
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
