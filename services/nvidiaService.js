const fs = require('fs');
const OpenAI = require('openai');
const { sniffImageBuffer } = require('./uploadService');

// Free-tier vision models via NVIDIA's NIM catalog (build.nvidia.com) - an OpenAI-compatible
// endpoint. NVIDIA retires and re-provisions catalog models often (this app has already lost
// moonshotai/kimi-k2.6 to an account-provisioning 404 and nvidia/nemotron-nano-12b-v2-vl to
// end-of-life), so nothing here assumes one model stays available: NVIDIA_MODEL picks the
// primary, NVIDIA_FALLBACK_MODEL a second one tried automatically if the primary is gone or
// failing, and either can be changed in .env without touching code.
//
// Chosen 2026-10-27 by running a real label photo through every vision model this account could
// list: nemotron-3.5-super-vl-120b-a12b read it correctly 4/4 times (12-65s depending on queue
// load). nemotron-3-nano-omni-30b-a3b-reasoning also works but took ~76s and sometimes returns
// blank fields (hence it's only the fallback); llama-3.2-90b-vision and gemma-4-31b hung past
// 150s; llama-3.2-11b-vision ignores the JSON schema and answers in markdown; gemma-3-12b 404s.
const DEFAULT_MODEL = 'nvidia/nemotron-3.5-super-vl-120b-a12b';
const DEFAULT_FALLBACK_MODEL = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning';

// Re-asks the same model this many times when it answers with unusable output (prose instead of
// JSON, truncated JSON, blank fields) before moving on to the next model.
const MAX_ATTEMPTS_PER_MODEL = 2;

// Each photo is sent base64-inlined and uploads can be up to 10MB x 12, so an uncapped request
// could be well over 100MB. The first few photos carry the identifying detail (labels, nameplates).
const MAX_AI_IMAGES = 4;

const CONDITIONS = [
  'NEW', 'NEW_OTHER', 'USED_EXCELLENT', 'USED_VERY_GOOD',
  'USED_GOOD', 'USED_ACCEPTABLE', 'FOR_PARTS_OR_NOT_WORKING',
];
const CONFIDENCES = ['high', 'medium', 'low'];

let cachedClient = null;
// Built lazily so merely requiring this module (aiService loads it at startup, tests load it too)
// doesn't throw when NVIDIA_API_KEY isn't set - the OpenAI SDK's constructor throws without a key.
function getClient() {
  if (cachedClient) return cachedClient;
  if (!process.env.NVIDIA_API_KEY) throw new Error('NVIDIA_API_KEY is not set');
  cachedClient = new OpenAI({
    apiKey: process.env.NVIDIA_API_KEY,
    baseURL: 'https://integrate.api.nvidia.com/v1',
    // The free tier queues requests, so a call can legitimately take over a minute - but the
    // SDK's 10-minute default would leave the seller staring at a spinner if one actually hangs.
    timeout: 90 * 1000,
    maxRetries: 1,
  });
  return cachedClient;
}

// Primary first, then the fallback. An explicitly empty NVIDIA_FALLBACK_MODEL turns the fallback off.
function resolveModels(env = process.env) {
  const primary = (env.NVIDIA_MODEL || '').trim() || DEFAULT_MODEL;
  const fallback = env.NVIDIA_FALLBACK_MODEL === undefined
    ? DEFAULT_FALLBACK_MODEL
    : env.NVIDIA_FALLBACK_MODEL.trim();
  return [primary, fallback].filter((m, i, all) => m && all.indexOf(m) === i);
}

const SYSTEM_PROMPT = `You are a listing assistant for an eBay store that sells industrial parts
(relays, contactors, PLC modules, sensors, motor starters, and similar equipment pulled from
manufacturing plants, mostly used/surplus condition).

Given one or more photos and/or free-text notes about a part, do your best to:
1. Identify the manufacturer, part number / model number, and general category.
2. Write an eBay title under 80 characters that leads with brand + part number (buyers search by
   exact part number), then a short descriptor.
3. Write a clear, honest description: what it is, typical applications, condition notes based on
   what's visible or stated, and any cross-reference/compatible part numbers you're confident about.
4. Suggest a realistic price range in USD based on typical resale value for this type of part and
   its condition (a low and high estimate) - note this is a rough estimate, not a guarantee.
5. Extract structured item specifics as key-value pairs (Brand, MPN, Type, Voltage, Amperage, etc.)
   - only include fields you can actually determine, don't guess wildly. Don't include a
   "Condition" entry here - condition is reported separately below.
6. Determine the item's condition from what's visible in the photo and stated in the notes. Don't
   default to "used" just because this store mostly sells surplus parts - some items are new or
   new-old-stock. If nothing indicates otherwise, "used, good condition" is the safest default.
7. Write a short category search phrase (2-6 words) describing what kind of part this is, for
   looking up the matching eBay category - e.g. "general purpose relay", "hydraulic spin-on
   filter", "PLC input output module", "motor starter". Describe the product type only, not the
   brand or part number.
8. Rate your own confidence as "high", "medium", or "low" based on how certain the identification is.
   If you can't clearly read a part number or model, say so and rate confidence "low" rather than
   inventing details.
9. Estimate the shipped package weight (lb) and box dimensions (length/width/height, inches) for
   this part - eBay uses these to calculate the buyer's shipping cost. Base it on the part's
   apparent physical size plus reasonable packaging (padding, small box). If you're unsure, give
   your best reasonable estimate rather than omitting it - the seller can correct it before publishing.

Respond with a single JSON object matching the given schema - no markdown fences, no commentary
outside the JSON.`;

const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'ebay_listing',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        part_number: { type: ['string', 'null'], description: 'Manufacturer part/model number, or null if not legible.' },
        brand: { type: ['string', 'null'], description: 'Manufacturer name, or null if unknown.' },
        title: { type: 'string', description: 'eBay listing title, under 80 characters, leading with brand + part number.' },
        description: { type: 'string', description: 'Full eBay listing description.' },
        price_low: { type: 'number', description: 'Low end of the estimated USD resale price range.' },
        price_high: { type: 'number', description: 'High end of the estimated USD resale price range.' },
        specifics: {
          type: 'array',
          description: 'Item specifics as key/value pairs (Brand, MPN, Type, Voltage, Amperage, Condition, etc). Only include fields you can actually determine.',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['key', 'value'],
            additionalProperties: false,
          },
        },
        condition: {
          type: 'string',
          enum: [
            'NEW', 'NEW_OTHER', 'USED_EXCELLENT', 'USED_VERY_GOOD',
            'USED_GOOD', 'USED_ACCEPTABLE', 'FOR_PARTS_OR_NOT_WORKING',
          ],
          description: 'eBay condition category. NEW = unused, in original packaging. NEW_OTHER = ' +
            'unused/never installed but no original packaging (e.g. new-old-stock pulled from a ' +
            'shelf). USED_EXCELLENT/VERY_GOOD/GOOD/ACCEPTABLE = used, in decreasing order of ' +
            'cosmetic/functional condition. FOR_PARTS_OR_NOT_WORKING = not confirmed functional.',
        },
        category_search_term: {
          type: 'string',
          description: 'Short phrase (2-6 words) describing the product type, for eBay category ' +
            'lookup - e.g. "general purpose relay", "hydraulic spin-on filter". Product type only, ' +
            'no brand or part number.',
        },
        confidence: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: 'How certain the identification is. Use "low" rather than inventing details.',
        },
        notes_for_seller: { type: 'string', description: 'Anything the seller should double-check before publishing.' },
        weight_lb: { type: 'number', description: 'Estimated shipped package weight in pounds, including packaging.' },
        length_in: { type: 'number', description: 'Estimated shipping box length in inches.' },
        width_in: { type: 'number', description: 'Estimated shipping box width in inches.' },
        height_in: { type: 'number', description: 'Estimated shipping box height in inches.' },
      },
      required: [
        'part_number', 'brand', 'title', 'description', 'price_low', 'price_high', 'specifics',
        'condition', 'category_search_term', 'confidence', 'notes_for_seller',
        'weight_lb', 'length_in', 'width_in', 'height_in',
      ],
      additionalProperties: false,
    },
  },
};

// Models don't always honor response_format: some wrap the JSON in a markdown fence, prepend
// reasoning in <think> tags, or ignore the schema and answer in prose. Pull out the JSON object
// if there is one; null means "nothing usable" and the caller retries.
function extractJson(text) {
  if (typeof text !== 'string') return null;
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  const candidates = [cleaned];
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(cleaned.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function toOptionalString(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s || null;
}

// The schema asks for specifics as [{key, value}] (structured output can't describe an open-ended
// object); the rest of the app wants a plain {key: value} object. Also accepts a plain object in
// case a model returns that instead.
function normalizeSpecifics(specifics) {
  const out = {};
  if (Array.isArray(specifics)) {
    for (const item of specifics) {
      if (item && typeof item.key === 'string' && item.key.trim() && item.value != null && String(item.value).trim()) {
        out[item.key.trim()] = String(item.value).trim();
      }
    }
  } else if (specifics && typeof specifics === 'object') {
    for (const [key, value] of Object.entries(specifics)) {
      if (value != null && typeof value !== 'object' && String(value).trim()) out[key] = String(value).trim();
    }
  }
  return out;
}

// Returns the cleaned listing, or null if the model's answer isn't usable (blank title or
// description, non-numeric prices) - a "successful" response full of empty strings is worse than
// an error, since it would save a blank draft. Recoverable slips (out-of-range enum, inverted
// price range, over-long title) are repaired rather than rejected.
function validateListing(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  let priceLow = toNumber(raw.price_low);
  let priceHigh = toNumber(raw.price_high);
  if (!title || !description || priceLow === null || priceHigh === null || priceLow < 0 || priceHigh < 0) {
    return null;
  }
  if (priceLow > priceHigh) [priceLow, priceHigh] = [priceHigh, priceLow];

  const positive = (v) => {
    const n = toNumber(v);
    return n !== null && n > 0 ? n : null;
  };

  return {
    part_number: toOptionalString(raw.part_number),
    brand: toOptionalString(raw.brand),
    title: title.slice(0, 80), // eBay's hard title limit
    description,
    price_low: priceLow,
    price_high: priceHigh,
    specifics: normalizeSpecifics(raw.specifics),
    condition: CONDITIONS.includes(raw.condition) ? raw.condition : 'USED_GOOD',
    category_search_term: toOptionalString(raw.category_search_term) || title,
    confidence: CONFIDENCES.includes(raw.confidence) ? raw.confidence : 'low',
    notes_for_seller: typeof raw.notes_for_seller === 'string' ? raw.notes_for_seller.trim() : '',
    weight_lb: positive(raw.weight_lb),
    length_in: positive(raw.length_in),
    width_in: positive(raw.width_in),
    height_in: positive(raw.height_in),
  };
}

function buildImageBlock(imagePath) {
  const buffer = fs.readFileSync(imagePath);
  // Trust the bytes, not the filename - uploads keep the client's original extension.
  const mediaType = sniffImageBuffer(buffer) || 'image/jpeg';
  return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${buffer.toString('base64')}` } };
}

function abortError() {
  const err = new Error('Generation cancelled.');
  err.name = 'AbortError';
  return err;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// What to do with an error thrown by the API call itself:
//   'auth'  - bad key: every model would fail identically, so stop and say so.
//   'skip'  - this model is unavailable or erroring (404/410 retired or unprovisioned, 429, 5xx,
//             timeout, connection drop): the SDK has already retried transient ones, so move on
//             to the next model rather than hammering this one.
//   'throw' - anything else is a bug on our side (not an API failure) and shouldn't be masked.
function classifyApiError(err) {
  if (err && (err.status === 401 || err.status === 403)) return 'auth';
  if (err && typeof err.status === 'number') return 'skip';
  if (err instanceof OpenAI.APIConnectionError) return 'skip';
  return 'throw';
}

// Outcome of one model response: a usable listing, a refusal (don't retry - a different model or
// attempt won't change a content-filter decision on the same input), or unusable output (retry).
function interpretResponse(response) {
  const choice = response && response.choices && response.choices[0];
  if (!choice) return { reason: 'no choices returned' };
  if (choice.finish_reason === 'content_filter') return { refused: true };
  if (choice.finish_reason === 'length') return { reason: 'response cut off' };

  const listing = validateListing(extractJson(choice.message && choice.message.content));
  return listing ? { listing } : { reason: 'unusable output' };
}

// `deps` exists for tests: an injected client/sleep/model list so no network is touched.
async function generateListing({ imagePaths, rawInput, signal }, deps = {}) {
  const content = [];
  for (const imagePath of (imagePaths || []).slice(0, MAX_AI_IMAGES)) {
    content.push(buildImageBlock(imagePath));
  }
  content.push({
    type: 'text',
    text: rawInput && rawInput.trim().length > 0
      ? `Seller notes / part info:\n${rawInput}`
      : 'No text notes were provided - identify the part from the photo(s) alone if possible.',
  });

  const client = deps.client || getClient();
  const sleep = deps.sleep || defaultSleep;
  const models = deps.models || resolveModels();

  let lastFailure = 'no model available';

  for (const model of models) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt += 1) {
      let response;
      try {
        response = await client.chat.completions.create({
          model,
          max_tokens: 4096,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content },
          ],
          response_format: RESPONSE_FORMAT,
        }, { signal });
      } catch (err) {
        // Callers (the new-draft route's cancel handling) check err.name === 'AbortError'
        // regardless of which SDK threw it.
        if ((signal && signal.aborted) || err instanceof OpenAI.APIUserAbortError) throw abortError();

        const kind = classifyApiError(err);
        if (kind === 'auth') {
          throw new Error('AI service authentication failed - check that NVIDIA_API_KEY is set correctly.');
        }
        if (kind === 'throw') throw err;

        // Full detail stays in the server log (API errors can include account identifiers);
        // the seller only ever sees a generic message.
        console.error(`AI model ${model} failed (${err.status || err.name}): ${err.message}`);
        lastFailure = `${model}: ${err.status || err.name}`;
        break; // next model
      }

      const outcome = interpretResponse(response);
      if (outcome.listing) return outcome.listing;
      if (outcome.refused) {
        throw new Error('The AI declined to generate this listing (content filter). Try different seller notes or a different photo.');
      }

      console.error(`AI model ${model} gave ${outcome.reason} (attempt ${attempt}/${MAX_ATTEMPTS_PER_MODEL})`);
      lastFailure = `${model}: ${outcome.reason}`;
      if (attempt < MAX_ATTEMPTS_PER_MODEL) await sleep(1000 * attempt);
    }
  }

  throw new Error(`The AI service is unavailable right now (${lastFailure}). Please try again in a minute.`);
}

module.exports = {
  generateListing, extractJson, validateListing, resolveModels,
  MAX_AI_IMAGES, DEFAULT_MODEL, DEFAULT_FALLBACK_MODEL,
};
