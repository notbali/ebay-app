const {
  S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');
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

// Removes every photo uploaded to R2 for one seller (the "parts/<userId>/" namespace above) - used
// when they delete their account, so nothing of theirs stays publicly readable afterwards.
// `client`/`bucket` are injectable for tests. Throws if R2 reports any key it couldn't delete,
// rather than claiming success. A no-op (skipped) when R2 isn't configured, i.e. local dev.
async function deleteUserPhotos(userId, { client, bucket = process.env.R2_BUCKET_NAME } = {}) {
  // The prefix is built from this value, so anything but a plain positive integer is refused - a
  // malformed id like "" or "7/../" must never widen the prefix into other sellers' photos.
  if (!Number.isInteger(userId) || userId <= 0) throw new Error('deleteUserPhotos needs a positive integer user id');
  if (!bucket) return { skipped: true, deleted: 0 };

  const s3 = client || getClient();
  // Trailing slash matters: "parts/7" would also match "parts/70/...".
  const prefix = `parts/${userId}/`;
  let deleted = 0;
  let continuationToken;

  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken,
    }));
    const objects = (page.Contents || []).map((o) => ({ Key: o.Key }));

    // DeleteObjects accepts at most 1000 keys per request.
    for (let i = 0; i < objects.length; i += 1000) {
      const batch = objects.slice(i, i + 1000);
      const result = await s3.send(new DeleteObjectsCommand({
        Bucket: bucket, Delete: { Objects: batch, Quiet: true },
      }));
      if (result.Errors && result.Errors.length) {
        const detail = result.Errors.map((e) => `${e.Key}: ${e.Message}`).join('; ');
        throw new Error(`R2 could not delete some photos: ${detail}`);
      }
      deleted += batch.length;
    }

    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  return { deleted };
}

module.exports = { uploadPartPhoto, deleteUserPhotos, getClient };
