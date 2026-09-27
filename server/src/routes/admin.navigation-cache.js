import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import db from '../db.js';
import { config } from '../config.js';
import { requireSuperAdmin } from '../middleware/auth.js';
import { recordAudit } from '../services/auditLog.js';

const SCHEMA = 4;
const HEADER_BYTES = 84;
const MAGIC = Buffer.from('LCMVNAV1', 'ascii');
const ENDIAN = 0x01020304;
const root = path.resolve(config.bot.navigationCacheDir);
const temp = path.join(root, '_tmp');
fs.mkdirSync(temp, { recursive: true });

const upload = multer({
  dest: temp,
  limits: { files: 512, fileSize: 512 * 1024 * 1024, fieldSize: 1024 },
  fileFilter: (_req, file, cb) => cb(null, /\.mvnav$/i.test(file.originalname)),
});
const router = Router();

function cleanUploads(files = []) {
  for (const file of files) {
    try { fs.unlinkSync(file.path); } catch (_) { /* already moved/removed */ }
  }
}

function hashFile(filePath, start = 0) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { start });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function inspectCache(file) {
  const stat = await fs.promises.stat(file.path);
  if (stat.size <= HEADER_BYTES) throw new Error(`${file.originalname}: truncated cache`);
  const handle = await fs.promises.open(file.path, 'r');
  const header = Buffer.alloc(HEADER_BYTES);
  try {
    const read = await handle.read(header, 0, header.length, 0);
    if (read.bytesRead !== header.length) throw new Error(`${file.originalname}: truncated header`);
  } finally { await handle.close(); }

  if (!header.subarray(0, 8).equals(MAGIC)) throw new Error(`${file.originalname}: invalid cache magic`);
  const schema = header.readUInt32LE(8);
  const endian = header.readUInt32LE(12);
  const zoneNo = header.readUInt32LE(16);
  const fingerprint = header.subarray(20, 52).toString('hex');
  const storedPayloadHash = header.subarray(52, 84).toString('hex');
  if (schema !== SCHEMA) throw new Error(`${file.originalname}: schema ${schema}, expected ${SCHEMA}`);
  if (endian !== ENDIAN) throw new Error(`${file.originalname}: unsupported endian marker`);
  const expectedName = `zone_${zoneNo}_${fingerprint}.mvnav`;
  if (path.basename(file.originalname).toLowerCase() !== expectedName.toLowerCase())
    throw new Error(`${file.originalname}: filename does not match header (${expectedName})`);
  const [sha256, payloadHash] = await Promise.all([
    hashFile(file.path), hashFile(file.path, HEADER_BYTES),
  ]);
  if (payloadHash !== storedPayloadHash)
    throw new Error(`${file.originalname}: payload SHA-256 mismatch`);
  return { zoneNo, fileName: expectedName, byteSize: stat.size, sha256, fingerprint,
    temporaryPath: file.path };
}

// Includes empty servers so the homepage can always offer the intended target.
router.get('/', requireSuperAdmin, async (_req, res) => {
  const servers = await db('game_servers as s')
    .leftJoin('navigation_cache_packages as p', 'p.server_id', 's.id')
    .orderBy('s.name', 'asc')
    .select('s.id as server_id', 's.name as server_name', 's.variant', 's.visible',
      'p.id as package_id', 'p.schema_version', 'p.file_count', 'p.total_bytes',
      'p.manifest_sha256', 'p.uploaded_at', 'p.updated_at');
  res.json({ schema_version: SCHEMA, data: servers.map((server) => ({ ...server,
    schema_version: server.schema_version == null ? null : Number(server.schema_version),
    file_count: server.file_count == null ? null : Number(server.file_count),
    total_bytes: server.total_bytes == null ? null : Number(server.total_bytes),
  })) });
});

// A browser directory/file multi-select publishes a complete replacement
// package. The old package stays active until every cache has been validated,
// moved and the database transaction commits.
router.post('/:serverId', requireSuperAdmin, upload.array('files', 512), async (req, res) => {
  const files = req.files || [];
  const serverId = Number.parseInt(req.params.serverId, 10);
  if (!Number.isInteger(serverId) || serverId <= 0) {
    cleanUploads(files); return res.status(400).json({ error: 'Invalid server id' });
  }
  const server = await db('game_servers').where('id', serverId).first();
  if (!server) { cleanUploads(files); return res.status(404).json({ error: 'Server not found' }); }
  if (files.length === 0) return res.status(422).json({ error: 'Select at least one .mvnav file' });

  let inspected;
  try {
    inspected = [];
    for (const file of files) inspected.push(await inspectCache(file));
    const uploadBytes = inspected.reduce((sum, file) => sum + file.byteSize, 0);
    if (uploadBytes > 8 * 1024 * 1024 * 1024)
      throw new Error('Cache package exceeds the 8 GiB package limit');
    const names = new Set();
    for (const item of inspected) {
      const key = item.fileName.toLowerCase();
      if (names.has(key)) throw new Error(`Duplicate cache file: ${item.fileName}`);
      names.add(key);
    }
  } catch (error) {
    cleanUploads(files);
    return res.status(422).json({ error: error.message });
  }

  inspected.sort((a, b) => a.fileName.localeCompare(b.fileName));
  const totalBytes = inspected.reduce((sum, file) => sum + file.byteSize, 0);
  const manifestShape = inspected.map(({ zoneNo, fileName, byteSize, sha256, fingerprint }) =>
    ({ zone_no: zoneNo, file_name: fileName, byte_size: byteSize, sha256,
       source_fingerprint: fingerprint }));
  const manifestSha256 = crypto.createHash('sha256')
    .update(JSON.stringify({ schema_version: SCHEMA, files: manifestShape }))
    .digest('hex');
  const storageKey = `server-${serverId}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const publishDir = path.join(root, storageKey);
  fs.mkdirSync(publishDir, { recursive: true });
  try {
    for (const file of inspected)
      fs.renameSync(file.temporaryPath, path.join(publishDir, file.fileName));
  } catch (error) {
    cleanUploads(files);
    fs.rmSync(publishDir, { recursive: true, force: true });
    return res.status(500).json({ error: `Could not publish cache files: ${error.message}` });
  }

  let oldStorageKey = null;
  try {
    await db.transaction(async (trx) => {
      const existing = await trx('navigation_cache_packages').where('server_id', serverId).first();
      oldStorageKey = existing?.storage_key || null;
      let packageId;
      if (existing) {
        packageId = existing.id;
        await trx('navigation_cache_files').where('package_id', packageId).del();
        await trx('navigation_cache_packages').where('id', packageId).update({
          schema_version: SCHEMA, file_count: inspected.length, total_bytes: totalBytes,
          storage_key: storageKey, manifest_sha256: manifestSha256,
          uploaded_by: req.session.user.id, uploaded_at: trx.fn.now(), updated_at: trx.fn.now(),
        });
      } else {
        [packageId] = await trx('navigation_cache_packages').insert({
          server_id: serverId, schema_version: SCHEMA, file_count: inspected.length,
          total_bytes: totalBytes, storage_key: storageKey,
          manifest_sha256: manifestSha256, uploaded_by: req.session.user.id,
        });
      }
      await trx('navigation_cache_files').insert(manifestShape.map((file) => ({
        package_id: packageId, zone_no: file.zone_no, file_name: file.file_name,
        byte_size: file.byte_size, sha256: file.sha256,
        source_fingerprint: file.source_fingerprint,
      })));
    });
  } catch (error) {
    fs.rmSync(publishDir, { recursive: true, force: true });
    return res.status(500).json({ error: `Could not publish cache manifest: ${error.message}` });
  }
  if (oldStorageKey && oldStorageKey !== storageKey &&
      /^server-\d+-\d+-[0-9a-f]{12}$/.test(oldStorageKey))
    fs.rmSync(path.join(root, oldStorageKey), { recursive: true, force: true });

  await recordAudit(db, req, {
    action: 'navigation_cache.publish', subjectType: 'game_server', subjectId: serverId,
    newValues: { server: server.name, schema_version: SCHEMA,
      file_count: inspected.length, total_bytes: totalBytes, manifest_sha256: manifestSha256 },
  });
  res.status(201).json({ message: `Published ${inspected.length} caches for ${server.name}`,
    schema_version: SCHEMA, file_count: inspected.length, total_bytes: totalBytes,
    manifest_sha256: manifestSha256 });
});

export default router;
