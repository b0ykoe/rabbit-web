import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import db from '../db.js';
import { config } from '../config.js';
import { requireSuperAdmin } from '../middleware/auth.js';
import { recordAudit } from '../services/auditLog.js';

const SCHEMA = 4;
const HEADER_BYTES = 84;
const MAGIC = Buffer.from('LCMVNAV1', 'ascii');
const ENDIAN = 0x01020304;
const MAX_CACHE_FILES = 512;
const MAX_CACHE_FILE_BYTES = 512 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 2048;
const root = path.resolve(config.bot.navigationCacheDir);
const temp = path.join(root, '_tmp');
fs.mkdirSync(temp, { recursive: true });

const upload = multer({
  dest: temp,
  limits: { files: MAX_CACHE_FILES, fileSize: MAX_CACHE_FILE_BYTES, fieldSize: 1024 },
  fileFilter: (_req, file, cb) => cb(null, /\.mvnav$/i.test(file.originalname)),
});
const archiveUpload = multer({
  dest: temp,
  limits: { files: 1, fileSize: MAX_ARCHIVE_BYTES, fields: 0, parts: 1 },
  fileFilter: (_req, file, cb) => cb(null, /\.zip$/i.test(file.originalname)),
});
const router = Router();

class UploadError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

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

function receiveUpload(middleware, req, res) {
  return new Promise((resolve, reject) => {
    middleware(req, res, (error) => error ? reject(error) : resolve());
  });
}

function openZip(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, {
      lazyEntries: true,
      autoClose: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
    }, (error, zipfile) => error ? reject(error) : resolve(zipfile));
  });
}

function openZipEntry(zipfile, entry) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream));
  });
}

async function extractCacheArchive(archivePath, extractDir) {
  await fs.promises.mkdir(extractDir, { recursive: true });
  const zipfile = await openZip(archivePath);
  const files = [];
  const names = new Set();
  let entryCount = 0;
  let totalBytes = 0;

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { zipfile.close(); } catch (_) { /* already closed */ }
      reject(error);
    };

    zipfile.on('error', fail);
    zipfile.on('end', () => {
      if (settled) return;
      settled = true;
      if (files.length === 0) reject(new Error('The ZIP archive contains no .mvnav files'));
      else resolve(files);
    });
    zipfile.on('entry', async (entry) => {
      try {
        entryCount += 1;
        if (entryCount > MAX_ARCHIVE_ENTRIES)
          throw new Error(`ZIP archive contains more than ${MAX_ARCHIVE_ENTRIES} entries`);

        const normalized = entry.fileName.replace(/\\/g, '/');
        const fileName = path.posix.basename(normalized);
        const isDirectory = normalized.endsWith('/');
        if (isDirectory || !/\.mvnav$/i.test(fileName)) {
          zipfile.readEntry();
          return;
        }
        if (files.length >= MAX_CACHE_FILES)
          throw new Error(`ZIP archive contains more than ${MAX_CACHE_FILES} cache files`);
        if (entry.uncompressedSize > MAX_CACHE_FILE_BYTES)
          throw new Error(`${fileName}: uncompressed file exceeds the 512 MiB limit`);
        totalBytes += entry.uncompressedSize;
        if (totalBytes > MAX_PACKAGE_BYTES)
          throw new Error('Uncompressed cache package exceeds the 8 GiB limit');

        const nameKey = fileName.toLowerCase();
        if (names.has(nameKey)) throw new Error(`Duplicate cache file in ZIP: ${fileName}`);
        names.add(nameKey);

        // Never use an archive path as a filesystem path. The original basename
        // is retained only for header/filename validation after extraction.
        const destination = path.join(extractDir,
          `${String(files.length).padStart(4, '0')}-${crypto.randomBytes(8).toString('hex')}.mvnav`);
        const input = await openZipEntry(zipfile, entry);
        await pipeline(input, fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
        files.push({ path: destination, originalname: fileName });
        zipfile.readEntry();
      } catch (error) {
        fail(error);
      }
    });
    zipfile.readEntry();
  });
}

async function resolveServer(serverId) {
  if (!Number.isInteger(serverId) || serverId <= 0)
    throw new UploadError(400, 'Invalid server id');
  const server = await db('game_servers').where('id', serverId).first();
  if (!server) throw new UploadError(404, 'Server not found');
  return server;
}

async function publishFiles(req, serverId, server, files) {
  if (files.length === 0) throw new UploadError(422, 'Select at least one .mvnav file');

  let inspected;
  try {
    inspected = [];
    for (const file of files) inspected.push(await inspectCache(file));
    const uploadBytes = inspected.reduce((sum, file) => sum + file.byteSize, 0);
    if (uploadBytes > MAX_PACKAGE_BYTES)
      throw new Error('Cache package exceeds the 8 GiB package limit');
    const names = new Set();
    for (const item of inspected) {
      const key = item.fileName.toLowerCase();
      if (names.has(key)) throw new Error(`Duplicate cache file: ${item.fileName}`);
      names.add(key);
    }
  } catch (error) {
    throw new UploadError(422, error.message);
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
    fs.rmSync(publishDir, { recursive: true, force: true });
    throw new UploadError(500, `Could not publish cache files: ${error.message}`);
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
    throw new UploadError(500, `Could not publish cache manifest: ${error.message}`);
  }
  if (oldStorageKey && oldStorageKey !== storageKey &&
      /^server-\d+-\d+-[0-9a-f]{12}$/.test(oldStorageKey)) {
    try { fs.rmSync(path.join(root, oldStorageKey), { recursive: true, force: true }); }
    catch (error) { console.warn(`[navigation-cache] Could not remove old package: ${error.message}`); }
  }

  await recordAudit(db, req, {
    action: 'navigation_cache.publish', subjectType: 'game_server', subjectId: serverId,
    newValues: { server: server.name, schema_version: SCHEMA,
      file_count: inspected.length, total_bytes: totalBytes, manifest_sha256: manifestSha256 },
  });
  return { message: `Published ${inspected.length} caches for ${server.name}`,
    schema_version: SCHEMA, file_count: inspected.length, total_bytes: totalBytes,
    manifest_sha256: manifestSha256 };
}

// Includes empty servers so the admin page can always offer the intended target.
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
  try {
    const serverId = Number.parseInt(req.params.serverId, 10);
    const server = await resolveServer(serverId);
    const result = await publishFiles(req, serverId, server, files);
    res.status(201).json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  } finally {
    cleanUploads(files);
  }
});

// Preferred upload path: one compressed archive is much less fragile through
// browsers and reverse proxies than hundreds of multipart file parts. Only
// .mvnav entries are extracted; publishFiles then performs the same full cache
// validation and atomic package replacement as the legacy folder upload.
router.post('/:serverId/archive', requireSuperAdmin, async (req, res) => {
  let archive = null;
  let extracted = [];
  let extractDir = null;
  try {
    await receiveUpload(archiveUpload.single('archive'), req, res);
    archive = req.file || null;
    if (!archive) throw new UploadError(422, 'Select one .zip cache archive');

    const serverId = Number.parseInt(req.params.serverId, 10);
    const server = await resolveServer(serverId);
    extractDir = path.join(temp, `extract-${crypto.randomUUID()}`);
    try {
      extracted = await extractCacheArchive(archive.path, extractDir);
    } catch (error) {
      throw new UploadError(422, `Invalid cache ZIP: ${error.message}`);
    }
    const result = await publishFiles(req, serverId, server, extracted);
    res.status(201).json(result);
  } catch (error) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : (error.status || 500);
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'Cache ZIP exceeds the 2 GiB server limit'
      : error.message;
    res.status(status).json({ error: message });
  } finally {
    if (archive) cleanUploads([archive]);
    cleanUploads(extracted);
    if (extractDir) fs.rmSync(extractDir, { recursive: true, force: true });
  }
});

router.delete('/:serverId', requireSuperAdmin, async (req, res) => {
  const serverId = Number.parseInt(req.params.serverId, 10);
  if (!Number.isInteger(serverId) || serverId <= 0)
    return res.status(400).json({ error: 'Invalid server id' });

  const server = await db('game_servers').where('id', serverId).first();
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const existing = await db('navigation_cache_packages').where('server_id', serverId).first();
  if (!existing) return res.status(404).json({ error: 'No navigation cache is published for this server' });

  await db('navigation_cache_packages').where('id', existing.id).del();
  if (/^server-\d+-\d+-[0-9a-f]{12}$/.test(existing.storage_key))
    fs.rmSync(path.join(root, existing.storage_key), { recursive: true, force: true });

  await recordAudit(db, req, {
    action: 'navigation_cache.delete', subjectType: 'game_server', subjectId: serverId,
    oldValues: { server: server.name, schema_version: existing.schema_version,
      file_count: Number(existing.file_count), total_bytes: Number(existing.total_bytes),
      manifest_sha256: existing.manifest_sha256 },
  });
  res.json({ message: `Deleted published navigation caches for ${server.name}` });
});

export default router;
