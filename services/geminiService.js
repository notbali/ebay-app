const fetch = require('node-fetch');
const fs = require('fs');

const GEMINI_MODEL = 'gemini-3.5-flash';
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM_PROMPT = `You are a listing assistant for an eBay store that sells industrial parts
(relays, contactors, PLC modules, sensors, motor starters, and similar equipment pulled from
manufacturing plants, mostly used/surplus condition).

Given a photo and/or free-text notes about a part, do your best to:
1. Identify the manufacturer, part number / model number, and general category.
2. Write an eBay title under 80 characters that leads with brand + part number (buyers search by
   exact part number), then a short descriptor.
3. Write a clear, honest description: what it is, typical applications, condition notes based on
   what's visible or stated, and any cross-reference/compatible part numbers you're confident about.
4. Suggest a realistic USED/SURPLUS price range in USD based on typical resale value for this type
   of part (a low and high estimate) - note this is a rough estimate, not a guarantee.
5. Extract structured item specifics as key-value pairs (Brand, MPN, Type, Voltage, Amperage,
   Condition, etc.) - only include fields you can actually determine, don't guess wildly.
6. Rate your own confidence as "high", "medium", or "low" based on how certain the identification is.
   If you can't clearly read a part number or model, say so and rate confidence "low" rather than
   inventing details.

Respond with ONLY a JSON object (no markdown fences, no preamble) matching this exact shape:
{
  "part_number": string | null,
  "brand": string | null,
  "title": string,
  "description": string,
  "price_low": number,
  "price_high": number,
  "specifics": { [key: string]: string },
  "confidence": "high" | "medium" | "low",
  "notes_for_seller": string
}`;

const MAX_ATTEMPTS = 3;

async function generateListing({ imagePath, rawInput }) {
  const parts = [];

  if (imagePath) {
    const imageData = fs.readFileSync(imagePath).toString('base64');
    const ext = imagePath.split('.').pop().toLowerCase();
    const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    parts.push({ inline_data: { mime_type: mimeType, data: imageData } });
  }

  parts.push({
    text: rawInput && rawInput.trim().length > 0
      ? `Seller notes / part info:\n${rawInput}`
      : 'No text notes were provided - identify the part from the photo alone if possible.',
  });

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await requestListing(parts);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

async function requestListing(parts) {
  const response = await fetch(`${API_URL}?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts }],
      generationConfig: {
        response_mime_type: 'application/json',
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const textBlock = data.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text;
  if (!textBlock) throw new Error('Gemini returned no text content');

  const cleaned = textBlock.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Failed to parse Gemini's JSON response: ${e.message}\nRaw: ${cleaned}`);
  }
}

module.exports = { generateListing };
