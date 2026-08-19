const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

function getClient() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

const CONTENT_TYPES = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

// eBay's Inventory API fetches listing photos itself from a public HTTPS URL - it can never
// reach localhost - so each photo is uploaded to R2 here and eBay is given the resulting
// public URL instead. Keys are namespaced per seller (userId) so photos from different sellers'
// accounts in this shared bucket can never collide or be confused with each other.
async function uploadPartPhoto(localPath, userId) {
  const key = `parts/${userId}/${path.basename(localPath)}`;
  const body = fs.readFileSync(localPath);
  const contentType = CONTENT_TYPES[path.extname(localPath).toLowerCase()] || 'application/octet-stream';

  await getClient().send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));

  const base = process.env.R2_PUBLIC_BASE_URL.replace(/\/+$/, '');
  return `${base}/${key}`;
}

module.exports = { uploadPartPhoto };
