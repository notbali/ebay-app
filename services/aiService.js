// Picks which AI provider backs generateListing() at startup, via AI_PROVIDER in .env.
// Every provider service implements the same generateListing({imagePaths, rawInput, signal})
// contract, so routes/parts.js and everything downstream stays provider-agnostic.
const PROVIDERS = {
  nvidia: './nvidiaService',
  claude: './claudeService',
  // Legacy value from when this provider was Kimi K2.6 - existing .env / deployment settings
  // still say AI_PROVIDER=kimi, so keep accepting it rather than crash on boot.
  kimi: './nvidiaService',
};

function resolveProvider(name) {
  const providerName = name || 'nvidia';
  const modulePath = PROVIDERS[providerName];
  if (!modulePath) {
    throw new Error(
      `Unknown AI_PROVIDER "${providerName}" - expected one of: ${Object.keys(PROVIDERS).join(', ')}`
    );
  }
  return modulePath;
}

const provider = require(resolveProvider(process.env.AI_PROVIDER));

module.exports = { generateListing: provider.generateListing, resolveProvider };
