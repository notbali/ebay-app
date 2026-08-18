// Picks which AI provider backs generateListing() at startup, via AI_PROVIDER in .env.
// Every provider service implements the same generateListing({imagePaths, rawInput, signal})
// contract, so routes/parts.js and everything downstream stays provider-agnostic.
const PROVIDERS = {
  kimi: './kimiService',
  claude: './claudeService',
};

const providerName = process.env.AI_PROVIDER || 'kimi';
const modulePath = PROVIDERS[providerName];

if (!modulePath) {
  throw new Error(
    `Unknown AI_PROVIDER "${providerName}" - expected one of: ${Object.keys(PROVIDERS).join(', ')}`
  );
}

module.exports = require(modulePath);
