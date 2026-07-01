const express = require('express');
const cors = require('cors');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json({ limit: '50mb' }));

// Serves the Bill Updater front-end at /app - put bill_updater_7.html (renamed to
// index.html) inside a "public" folder in the repo root, next to server.js:
//   public/index.html
// Then https://zoho-bill-server.onrender.com/app/ opens it - works from any phone
// browser, no separate hosting needed. Add it to your phone's home screen for an
// app-like icon (Chrome: menu -> "Add to Home screen"; Safari: Share -> "Add to
// Home Screen").
app.use('/app', express.static(path.join(__dirname, 'public')));

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

// FIX #5: When bill+bilty+bale-slips run together, the bilty step creates bale
// entries first (numbers only, meters empty), then the bale-slip step used to
// blindly APPEND its results on top - producing duplicate entries for the same
// bale number (one with empty meters from bilty, one with real meters from the
// slip). This merges by bale_no instead: if the number already exists, fill in
// its meters; only append a new row if the number genuinely wasn't there yet.
function mergeBales(existing, incoming) {
  const result = existing.map(b => ({ ...b, bale_no: String(b.bale_no).trim() }));
  for (const nb of incoming) {
    const key = String(nb.bale_no).trim();
    const idx = result.findIndex(b => b.bale_no === key);
    if (idx >= 0) {
      result[idx] = { ...result[idx], meters: nb.meters };
    } else {
      result.push({ bale_no: key, meters: nb.meters });
    }
  }
  return result;
}


// Claude 4.6+ models reject assistant-turn prefill outright ("This model does
// not support assistant message prefill"). The old '{' prefill
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
    bilty_no: { type: 'string', description: 'The number stamped or handwritten specifically inside the box labeled OFFICE USE ONLY, near the Actual/Charged weight fields. NOT any pre-printed serial number found elsewhere on the form (such as a printed reference number in a header or corner) - that is just the booklet stationery number, not the actual bilty number.' },
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


// FIX #7: Anthropic's API occasionally returns a transient "overloaded_error"
// (HTTP 529) or rate-limit error when their servers are under heavy load - this
// is not a bug in the request, it's momentary capacity on Anthropic's side. The
// old code threw immediately on any error, killing the whole extraction and
// forcing a manual retry. Now transient errors get retried automatically with
// exponential backoff before giving up.
function isTransientClaudeError(resp, data) {
  const errType = data?.error?.type;
  return errType === 'overloaded_error' || errType === 'rate_limit_error' || resp.status === 529 || resp.status === 429 || resp.status >= 500;
}

async function callClaude(prompt, imageBase64, mediaType, schema, maxRetries = 4) {
  let lastData, lastResp;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
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

    if (data.content) {
      const textBlock = data.content.find(c => c.type === 'text');
      if (!textBlock) throw new Error('Claude returned no text block: ' + JSON.stringify(data));
      return textBlock.text;
    }

    lastData = data; lastResp = resp;
    if (isTransientClaudeError(resp, data) && attempt < maxRetries) {
      const delay = Math.min(1000 * Math.pow(2, attempt), 16000) + Math.floor(Math.random() * 500);
      console.log(`⏳ Claude API transient error (${data.error?.type || resp.status}), retry ${attempt + 1}/${maxRetries} in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
    break; // non-transient error, or retries exhausted
  }
  throw new Error('Claude failed: ' + JSON.stringify(lastData));
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

// ── STEP 1: EXTRACT ONLY (no push to Zoho) ──
// Returns billData + bales so the front-end can show a review/edit screen before
// anything gets written to the sheet.
app.post('/extract-bill', async (req, res) => {
  try {
    const { mode, mainImageBase64, mainMediaType, baleImageBase64, baleMediaType,
            bale2ImageBase64, bale2MediaType, biltyImageBase64, biltyMediaType,
            sheetName, startRow, quality: manualQuality } = req.body;

    console.log(`📋 [EXTRACT] Mode: ${mode}, Sheet: ${sheetName}, Row: ${startRow}`);

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
        'This is a photo of a physical Bilty / LR (Lorry Receipt) document issued by a transport company (could be in any orientation, even sideways or upside down - read carefully). This document is the SOURCE OF TRUTH for transport details. Extract: bilty_no - CRITICAL: this is the number stamped (often in red ink) or handwritten specifically INSIDE the box labeled "OFFICE USE ONLY", which sits near the Actual/Charged weight fields. It is usually 5-6 digits. Every LR form also has a separate PRE-PRINTED serial number somewhere in the header or corner of the page (part of the printed stationery/booklet itself) - this is NOT the bilty_no, ignore it completely even though it may look more prominent or "official". Only use the number that is physically stamped or written inside the OFFICE USE ONLY box. Also extract: total_bales (the number written in the No. of Packages field, could be written as a word like Five = 5), transporter (the transport company name from the letterhead/logo at top, e.g. Shree Ram Roadways), and bale_numbers (every individual bale number from the Private Mark field - it often contains a handwritten range like "1012 TO 1016" or "1012-1016", which must be expanded into every individual number 1012,1013,1014,1015,1016 as separate array items, not left as a range. Read each digit carefully - handwritten 2 and 7 are easily confused, as are 1 and 7; look at the overall shape and any serif/flag stroke to tell them apart, and cross-check that consecutive numbers in a range make sense e.g. if you read 1021 then 1075 as the two ends of a range, reconsider whether the first digit is actually a 7 not a 2, since ranges are almost always small and sequential).',
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
          'Extract bale data from these handwritten packing slips. The image may be rotated - handle any orientation. Each packing slip has: 1) Bale No (a 4-digit number in a box e.g. 1128, 1127, 1126 - read each digit carefully, handwritten 1 and 7 are easily confused, as are 2 and 7; the bale numbers on slips from the same batch are usually close together sequentially, so use that as a sanity check) 2) Mtrs field showing TOTAL meters for that bale (e.g. 1014, 1038, 1024). ONLY use the TOTAL meters shown next to "Mtrs." - do NOT add up individual piece meters. Extract ALL bales visible regardless of image orientation.',
          baleImageBase64, baleMediaType, baleSlipSchema
        );
        const data1 = extractJSON(text);
        bales = mergeBales(bales, data1.bales || []);
        console.log(`✅ Bale slip 1: ${data1.bales?.length || 0} bales`);
      }

      // Second bale slip photo (optional)
      if (bale2ImageBase64) {
        console.log('📦 Reading bale slips photo 2...');
        const text = await callClaude(
          'Extract bale data from these handwritten packing slips. The image may be rotated - handle any orientation. Each packing slip has: 1) Bale No (a 4-digit number in a box e.g. 1128, 1127, 1126 - read each digit carefully, handwritten 1 and 7 are easily confused, as are 2 and 7; the bale numbers on slips from the same batch are usually close together sequentially, so use that as a sanity check) 2) Mtrs field showing TOTAL meters for that bale (e.g. 1014, 1038, 1024). ONLY use the TOTAL meters shown next to "Mtrs." - do NOT add up individual piece meters. Extract ALL bales visible regardless of image orientation.',
          bale2ImageBase64, bale2MediaType, baleSlipSchema
        );
        const data2 = extractJSON(text);
        bales = mergeBales(bales, data2.bales || []);
        console.log(`✅ Bale slip 2: ${data2.bales?.length || 0} bales`);
      }
    }

    // Soft warning only at extraction time (not a hard block) - the review screen
    // should show this to the user so they can fix it themselves before pushing.
    // See FIX #6 note in /push-bill below for the hard safety check.
    let baleCountWarning = null;
    if ((mode === 'full' || mode === 'bale') && bales.length > 0 && billData.total_bales) {
      const expectedCount = parseInt(billData.total_bales, 10);
      if (!isNaN(expectedCount) && bales.length !== expectedCount) {
        baleCountWarning = `Bilty says ${expectedCount} package(s), but ${bales.length} unique bale numbers were extracted. This usually means a bale number was misread from handwriting - double check the bale numbers below against the original photos before pushing.`;
        console.log(`⚠️ ${baleCountWarning}`);
      }
    }

    console.log(`📋 [EXTRACT] Done: ${bales.length} bales extracted, ready for review`);
    res.json({ success: true, mode, sheetName, startRow, billData, bales, warning: baleCountWarning });

  } catch(err) {
    console.error('❌ Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Shared push logic, used by /push-bill ──
// mode/sheetName/startRow/billData/bales come straight from the review screen -
// billData and bales may have been hand-edited by the user before this is called.
async function pushBillToSheet(mode, sheetName, startRow, billData, bales) {
  console.log(`📊 [PUSH] Sending ${bales.length} bales to Make.com...`);
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
    // Bale-only mode must NOT send blank values for bill-level fields - omit those
    // keys entirely so Make.com's Zoho update doesn't blank out existing bill data.
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
  console.log(`✅ [PUSH] Done: ${pushed} pushed, ${failed} failed`);
  return { results, pushed, failed };
}

// ── STEP 2: PUSH REVIEWED/EDITED DATA ──
// Call this after the user has reviewed (and possibly corrected) the data returned
// by /extract-bill. Nothing reaches Zoho until this endpoint is called.
app.post('/push-bill', async (req, res) => {
  try {
    const { mode, sheetName, startRow, billData, bales } = req.body;

    if (!sheetName || !startRow || !mode) {
      return res.status(400).json({ error: 'Missing required fields: mode, sheetName, startRow' });
    }
    if (!Array.isArray(bales)) {
      return res.status(400).json({ error: '"bales" must be an array (can be empty for bill-only summary row)' });
    }

    // FIX #6: GUARDRAIL - last check before anything is actually written to the sheet.
    // If the reviewer pushes without noticing a mismatch (or edited total_bales but
    // forgot to fix the bale list, or vice versa), stop here rather than write bad data.
    if ((mode === 'full' || mode === 'bale') && bales.length > 0 && billData?.total_bales) {
      const expectedCount = parseInt(billData.total_bales, 10);
      if (!isNaN(expectedCount) && bales.length !== expectedCount) {
        return res.status(422).json({
          error: `Bale count mismatch: total_bales is ${expectedCount} but ${bales.length} bale rows are being pushed: ${bales.map(b => `${b.bale_no}${b.meters !== '' ? ' (' + b.meters + 'm)' : ' (no meters)'}`).join(', ')}. Fix total_bales or the bale list, then push again.`,
          billData, bales
        });
      }
    }

    const { results, pushed, failed } = await pushBillToSheet(mode, sheetName, parseInt(startRow), billData || {}, bales);

    res.json({ success: failed === 0, billData, bales, results, pushed, failed, startRow });

  } catch(err) {
    console.error('❌ Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// ISSUE MODE — direct Zoho Sheets API (search-by-criteria + update)
// Separate from everything above: no Claude/photo involved. Takes typed
// bale/bill numbers + challan info, finds each row via Zoho's Tabular Data
// API, and updates the Grey Issue Details columns (R-V) on that exact row.
// ══════════════════════════════════════════════════════════════════

const ZOHO_ACCOUNTS_BASE = 'https://accounts.zoho.in';
const ZOHO_SHEET_API_BASE = 'https://sheet.zoho.in/api/v2';
const ZOHO_WORKBOOK_ID = process.env.ZOHO_WORKBOOK_ID || 'es1v56fd6be6434de4d9e98bd990c2858c394';

let zohoTokenCache = { accessToken: null, expiresAt: 0 };

async function getZohoAccessToken() {
  if (zohoTokenCache.accessToken && Date.now() < zohoTokenCache.expiresAt) {
    return zohoTokenCache.accessToken;
  }
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    refresh_token: process.env.ZOHO_REFRESH_TOKEN
  });
  const resp = await fetch(`${ZOHO_ACCOUNTS_BASE}/oauth/v2/token?${params.toString()}`, { method: 'POST' });
  const data = await resp.json();
  if (!data.access_token) throw new Error('Zoho token refresh failed: ' + JSON.stringify(data));
  // Refresh 2 minutes early so we never hand out a token that's about to expire mid-request
  zohoTokenCache = { accessToken: data.access_token, expiresAt: Date.now() + (data.expires_in - 120) * 1000 };
  return zohoTokenCache.accessToken;
}

// Searches for text within the given scope. Unlike the Tabular API, find does
// NOT stop at blank rows - it genuinely searches the whole worksheet.
async function zohoFindCells(worksheetName, searchText, scope, extra = {}) {
  const token = await getZohoAccessToken();
  const paramObj = { method: 'find', scope, search: String(searchText), worksheet_name: worksheetName };
  if (extra.column) paramObj.column = String(extra.column);
  if (extra.row) paramObj.row = String(extra.row);
  const params = new URLSearchParams(paramObj);
  const resp = await fetch(`${ZOHO_SHEET_API_BASE}/${ZOHO_WORKBOOK_ID}?${params.toString()}`, {
    method: 'POST',
    headers: { Authorization: `Zoho-oauthtoken ${token}` }
  });
  return resp.json();
}

// CSV-escapes a field for use in worksheet.csvdata.set's data parameter.
function csvEscape(val) {
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

const LOT_NO_COLUMN = 12;        // L - Lot No (bale number)
const BILL_NO_COLUMN = 9;        // I - Bill No.
const CHALLAN_START_COLUMN = 18; // R - first Grey Issue Details column

// Finds the exact row for a given Bill No. + Lot No (bale number) combination.
// Step 1: search column L for the bale number (works across blank-row gaps).
// Step 2: for each candidate row, verify column I on that SAME row matches the
// bill number - this is what protects against bale numbers that repeat across
// different bills (a real case we found in this sheet).
async function findConfirmedRow(sheetName, billNo, baleNo) {
  const baleSearch = await zohoFindCells(sheetName, baleNo, 'column', { column: LOT_NO_COLUMN });
  if (baleSearch.status !== 'success' || !baleSearch.cells || baleSearch.cells.length === 0) {
    return { error: `Bale ${baleNo} not found in ${sheetName} (searched Lot No column)` };
  }

  const confirmedRows = [];
  for (const cell of baleSearch.cells) {
    const billSearch = await zohoFindCells(sheetName, billNo, 'row', { row: cell.row_index });
    if (billSearch.status === 'success' && billSearch.cells) {
      const match = billSearch.cells.find(c => c.column_index === BILL_NO_COLUMN);
      if (match) confirmedRows.push(cell.row_index);
    }
    await new Promise(r => setTimeout(r, 200));
  }

  if (confirmedRows.length === 0) {
    return { error: `Bale ${baleNo} exists, but no row has Bill No. = "${billNo}" - double check the bill number` };
  }
  if (confirmedRows.length > 1) {
    return { error: `Ambiguous: bale ${baleNo} + bill ${billNo} matched ${confirmedRows.length} rows (${confirmedRows.join(', ')}) - likely a duplicate entry in the sheet, please check manually` };
  }
  return { rowIndex: confirmedRows[0] };
}

// Indian financial year: April to March. "2026-06-24" -> FY 2026-27 -> "26-27"
function computeFinancialYear(dateStr) {
  const d = new Date(dateStr);
  const month = d.getMonth() + 1;
  const year = d.getFullYear();
  const fyStart = month >= 4 ? year : year - 1;
  const fyEnd = fyStart + 1;
  return `${String(fyStart).slice(-2)}-${String(fyEnd).slice(-2)}`;
}

// HTML date input gives "YYYY-MM-DD" - convert to the sheet's "DD-Mon-YY" format
function formatChallanDate(dateStr) {
  const d = new Date(dateStr);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dd = String(d.getDate()).padStart(2, '0');
  const mon = months[d.getMonth()];
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}-${mon}-${yy}`;
}

// TEMPORARY DEBUG TOOL - lets us test different Zoho criteria syntax quickly
// without redeploying between attempts. Remove once /issue-bales is confirmed working.
// TEMPORARY DEBUG TOOL - list the first few rows with NO filter at all, to
// sanity-check whether the API is even looking at the same data you see on
// screen. Remove once /issue-bales is confirmed working.
// TEMPORARY DEBUG TOOL - lists every worksheet name/ID exactly as Zoho's API
// sees them, to compare against the tab names visible in the browser.
// TEMPORARY DEBUG TOOL - test zoho.sheet.find, which does a literal text search
// and returns row/column positions directly - unlike the Tabular API, this does
// NOT stop at blank rows, since it isn't trying to treat the sheet as one table.
app.post('/debug-zoho-find', async (req, res) => {
  try {
    const { sheetName, searchText, columnIndex, rowIndex } = req.body;
    if (!sheetName || !searchText) {
      return res.status(400).json({ error: 'Need sheetName and searchText' });
    }
    const token = await getZohoAccessToken();
    let scope = 'worksheet';
    if (rowIndex) scope = 'row';
    else if (columnIndex) scope = 'column';
    const paramObj = {
      method: 'find',
      scope,
      search: String(searchText),
      worksheet_name: sheetName
    };
    if (columnIndex) paramObj.column = String(columnIndex);
    if (rowIndex) paramObj.row = String(rowIndex);
    const params = new URLSearchParams(paramObj);
    const resp = await fetch(`${ZOHO_SHEET_API_BASE}/${ZOHO_WORKBOOK_ID}?${params.toString()}`, {
      method: 'POST',
      headers: { Authorization: `Zoho-oauthtoken ${token}` }
    });
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// TEMPORARY DEBUG TOOL - test the write method against a SAFE unused cell
// (defaults to row 5000, far from any real data) before trusting it near real rows.
app.post('/debug-zoho-write', async (req, res) => {
  try {
    const { sheetName, row, column, data } = req.body;
    if (!sheetName || !row || !column || !data) {
      return res.status(400).json({ error: 'Need sheetName, row, column, data' });
    }
    const token = await getZohoAccessToken();

    // Confirmed via Zoho's Deluge docs (zoho.sheet.insertCSV success response
    // literally shows "method": "worksheet.csvdata.set"). Parameter is named
    // csv_data, not "data".
    const params = new URLSearchParams({
      method: 'worksheet.csvdata.set',
      worksheet_name: sheetName,
      row: String(row),
      column: String(column),
      data: String(data)
    });
    const resp = await fetch(`${ZOHO_SHEET_API_BASE}/${ZOHO_WORKBOOK_ID}?${params.toString()}`, {
      method: 'POST',
      headers: { Authorization: `Zoho-oauthtoken ${token}` }
    });
    const result = await resp.json();
    res.json(result);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// TEMPORARY DEBUG TOOL - test reading a range, guessing the symmetric method
// name to the CONFIRMED write method (worksheet.csvdata.set).
app.post('/debug-zoho-read', async (req, res) => {
  try {
    const { sheetName, row, column, count } = req.body;
    if (!sheetName || !row || !column) {
      return res.status(400).json({ error: 'Need sheetName, row, column' });
    }
    const token = await getZohoAccessToken();
    const candidates = ['worksheet.csvdata.get', 'worksheet.range.get', 'worksheet.data.get'];
    const attempts = [];
    for (const method of candidates) {
      const params = new URLSearchParams({
        method,
        worksheet_name: sheetName,
        row: String(row),
        column: String(column),
        count: String(count || 1)
      });
      const resp = await fetch(`${ZOHO_SHEET_API_BASE}/${ZOHO_WORKBOOK_ID}?${params.toString()}`, {
        method: 'POST',
        headers: { Authorization: `Zoho-oauthtoken ${token}` }
      });
      const result = await resp.json();
      attempts.push({ method, result });
      if (result.status === 'success' || result.error_code !== 2867) break;
      await new Promise(r => setTimeout(r, 300));
    }
    res.json({ attempts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/debug-zoho-worksheets', async (req, res) => {
  try {
    const token = await getZohoAccessToken();
    const params = new URLSearchParams({ method: 'worksheet.list' });
    const resp = await fetch(`${ZOHO_SHEET_API_BASE}/${ZOHO_WORKBOOK_ID}?${params.toString()}`, {
      method: 'POST',
      headers: { Authorization: `Zoho-oauthtoken ${token}` }
    });
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/issue-bales', async (req, res) => {
  try {
    const { sheetName, challanDate, challanNo, partyName, bales } = req.body;

    if (!sheetName || !challanDate || !challanNo || !partyName) {
      return res.status(400).json({ error: 'Missing required fields: sheetName, challanDate, challanNo, partyName' });
    }
    if (!Array.isArray(bales) || bales.length === 0) {
      return res.status(400).json({ error: '"bales" must be a non-empty array of { billNo, baleNo }' });
    }

    const formattedDate = formatChallanDate(challanDate);
    const fy = computeFinancialYear(challanDate);
    const slipNo = `${challanNo}/${fy}`;

    const results = [];

    for (const { billNo, baleNo } of bales) {
      console.log(`🔍 Locating bill ${billNo} + bale ${baleNo} in ${sheetName}...`);
      const found = await findConfirmedRow(sheetName, billNo, baleNo);

      if (found.error) {
        results.push({ billNo, baleNo, success: false, error: found.error });
        continue;
      }

      const rowIndex = found.rowIndex;

      // Write Challan Date, Challan No, Party Name, Challan Mtr, Slip No (columns
      // R-V) in one call. Challan Mtr is written as a formula referencing this
      // same row's own Lot Mtr (column M) - Zoho evaluates it live, so we never
      // need a separate "read" step to know the value ahead of time.
      const csvRow = [
        csvEscape(formattedDate),
        csvEscape(challanNo),
        csvEscape(partyName),
        `=M${rowIndex}`,
        csvEscape(slipNo)
      ].join(',');

      const token = await getZohoAccessToken();
      const params = new URLSearchParams({
        method: 'worksheet.csvdata.set',
        worksheet_name: sheetName,
        row: String(rowIndex),
        column: String(CHALLAN_START_COLUMN),
        data: csvRow
      });
      const resp = await fetch(`${ZOHO_SHEET_API_BASE}/${ZOHO_WORKBOOK_ID}?${params.toString()}`, {
        method: 'POST',
        headers: { Authorization: `Zoho-oauthtoken ${token}` }
      });
      const writeResult = await resp.json();

      results.push({
        billNo, baleNo, rowIndex,
        success: writeResult.status === 'success',
        error: writeResult.status !== 'success' ? writeResult.error_message : undefined
      });

      await new Promise(r => setTimeout(r, 300));
    }

    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    console.log(`✅ Issue done: ${succeeded} succeeded, ${failed} failed`);
    res.json({ success: failed === 0, sheetName, challanDate: formattedDate, challanNo, partyName, slipNo, results, succeeded, failed });

  } catch (err) {
    console.error('❌ Issue error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
