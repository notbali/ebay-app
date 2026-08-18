const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

// Free tier via NVIDIA's NIM catalog (build.nvidia.com) - OpenAI-compatible endpoint. Defaults
// to Moonshot AI's Kimi K2.6, but is overridable via NVIDIA_MODEL because as of 2026-08-18,
// "moonshotai/kimi-k2.6" 404s ("Function not found for account") for many accounts due to an
// open NVIDIA-side account provisioning bug (see NVIDIA Developer Forums thread #378046) -
// unrelated to this integration. .env is currently pinned to a working substitute
// (nvidia/nemotron-nano-12b-v2-vl) to prove the pipeline end-to-end; switch NVIDIA_MODEL back
// to moonshotai/kimi-k2.6 once NVIDIA resolves the bug.
const MODEL = process.env.NVIDIA_MODEL || 'moonshotai/kimi-k2.6';

const client = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: 'https://integrate.api.nvidia.com/v1',
});

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

function buildImageBlock(imagePath) {
  const imageData = fs.readFileSync(imagePath).toString('base64');
  const ext = path.extname(imagePath).slice(1).toLowerCase();
  const mediaType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${imageData}` } };
}

async function generateListing({ imagePaths, rawInput, signal }) {
  const content = [];

  for (const imagePath of imagePaths || []) {
    content.push(buildImageBlock(imagePath));
  }

  content.push({
    type: 'text',
    text: rawInput && rawInput.trim().length > 0
      ? `Seller notes / part info:\n${rawInput}`
      : 'No text notes were provided - identify the part from the photo(s) alone if possible.',
  });

  let response;
  try {
    response = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 4096,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content },
      ],
      response_format: RESPONSE_FORMAT,
    }, { signal });
  } catch (err) {
    // Mirrors claudeService's abort normalization - callers (the publish route's cancel
    // handling, etc.) check err.name === 'AbortError' regardless of which SDK threw it.
    if (signal && signal.aborted) {
      const abortErr = new Error('Generation cancelled.');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    throw translateApiError(err);
  }

  const choice = response.choices && response.choices[0];
  if (!choice) throw new Error('Kimi returned no choices.');

  if (choice.finish_reason === 'length') {
    throw new Error('Kimi\'s response was cut off before it finished the listing. Try shorter seller notes.');
  }

  if (choice.finish_reason === 'content_filter') {
    throw new Error('Kimi declined to generate this listing (content filter). Try different seller notes or a different photo.');
  }

  const text = choice.message && choice.message.content;
  if (!text) throw new Error('Kimi returned no text content.');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Failed to parse Kimi's JSON response: ${e.message}`);
  }

  return {
    ...parsed,
    specifics: Object.fromEntries((parsed.specifics || []).map(({ key, value }) => [key, value])),
  };
}

function translateApiError(err) {
  if (err instanceof OpenAI.AuthenticationError) {
    return new Error('Kimi (NVIDIA) API authentication failed - check that NVIDIA_API_KEY is set correctly.');
  }
  if (err instanceof OpenAI.RateLimitError) {
    return new Error('Kimi (NVIDIA) API rate limit reached - please wait a moment and try again.');
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new Error('Could not reach the NVIDIA API - check your network connection.');
  }
  if (err instanceof OpenAI.APIError) {
    return new Error(`Kimi (NVIDIA) API error (${err.status}): ${err.message}`);
  }
  return err;
}

module.exports = { generateListing };
