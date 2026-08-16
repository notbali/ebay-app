const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-opus-5';

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

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
7. Rate your own confidence as "high", "medium", or "low" based on how certain the identification is.
   If you can't clearly read a part number or model, say so and rate confidence "low" rather than
   inventing details.`;

// Structured outputs enforce this shape server-side, so the response is always valid JSON -
// no markdown-fence stripping or parse-and-retry loop needed. `specifics` is a list of
// {key, value} pairs rather than an open-ended object because structured output schemas
// require `additionalProperties: false` and can't describe an arbitrary key set.
const RESPONSE_FORMAT = {
  type: 'json_schema',
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
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description: 'How certain the identification is. Use "low" rather than inventing details.',
      },
      notes_for_seller: { type: 'string', description: 'Anything the seller should double-check before publishing.' },
    },
    required: [
      'part_number', 'brand', 'title', 'description',
      'price_low', 'price_high', 'specifics', 'condition', 'confidence', 'notes_for_seller',
    ],
    additionalProperties: false,
  },
};

function buildImageBlock(imagePath) {
  const imageData = fs.readFileSync(imagePath).toString('base64');
  const ext = path.extname(imagePath).slice(1).toLowerCase();
  const mediaType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageData } };
}

async function generateListing({ imagePaths, rawInput }) {
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
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
      output_config: { effort: 'medium', format: RESPONSE_FORMAT },
    });
  } catch (err) {
    throw translateApiError(err);
  }

  if (response.stop_reason === 'refusal') {
    const category = response.stop_details && response.stop_details.category;
    throw new Error(
      `Claude declined to generate this listing${category ? ` (${category})` : ''}. ` +
      'Try different seller notes or a different photo.'
    );
  }

  if (response.stop_reason === 'max_tokens') {
    throw new Error('Claude\'s response was cut off before it finished the listing. Try shorter seller notes.');
  }

  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock) throw new Error('Claude returned no text content.');

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (e) {
    throw new Error(`Failed to parse Claude's JSON response: ${e.message}`);
  }

  return {
    ...parsed,
    specifics: Object.fromEntries((parsed.specifics || []).map(({ key, value }) => [key, value])),
  };
}

function translateApiError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return new Error('Claude API authentication failed - check that ANTHROPIC_API_KEY is set correctly.');
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new Error('Claude API rate limit reached - please wait a moment and try again.');
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new Error('Could not reach the Claude API - check your network connection.');
  }
  if (err instanceof Anthropic.APIError) {
    return new Error(`Claude API error (${err.status}): ${err.message}`);
  }
  return err;
}

module.exports = { generateListing };
