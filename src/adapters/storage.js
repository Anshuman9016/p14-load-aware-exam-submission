// File storage: local disk (MODE=local) or Amazon S3 (MODE=aws). Same interface for both.
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const config = require('../config');

function localPath(key) {
  const p = path.resolve(config.localStorageDir, key);
  if (!p.startsWith(path.resolve(config.localStorageDir))) throw new Error('Invalid key');
  return p;
}

const local = {
  async put(key, buffer) {
    const p = localPath(key);
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(p, buffer);
  },
  async exists(key) {
    try { await fs.promises.access(localPath(key)); return true; } catch { return false; }
  },
  async remove(key) {
    await fs.promises.rm(localPath(key), { force: true });
  },
  // Short-lived signed link served by GET /api/files/:token
  async downloadUrl(key, filename) {
    const token = jwt.sign({ key, filename }, config.jwtSecret, { expiresIn: config.downloadLinkSeconds });
    return `/api/files/${token}`;
  },
  readStream(key) {
    return fs.createReadStream(localPath(key));
  },
};

function makeS3() {
  const { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const s3 = new S3Client({ region: config.aws.region });
  const Bucket = config.aws.bucket;
  return {
    async put(key, buffer, contentType) {
      await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: buffer, ContentType: contentType }));
    },
    async exists(key) {
      try { await s3.send(new HeadObjectCommand({ Bucket, Key: key })); return true; }
      catch (e) { if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return false; throw e; }
    },
    async remove(key) {
      await s3.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
    // Presigned URL that expires after 5 minutes (SRS 6.3)
    async downloadUrl(key, filename) {
      return getSignedUrl(s3, new GetObjectCommand({
        Bucket, Key: key,
        ResponseContentDisposition: `attachment; filename="${(filename || 'answer').replace(/"/g, '')}"`,
      }), { expiresIn: config.downloadLinkSeconds });
    },
  };
}

module.exports = config.mode === 'aws' ? makeS3() : local;
