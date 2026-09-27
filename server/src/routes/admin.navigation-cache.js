import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { finished, pipeline } from 'node:stream/promises';
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
const MAX_UPLOAD_PARTS = 64;
const MAX_UPLOAD_PART_BYTES = 80 * 1024 * 1024;
const PART_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const root = path.resolve(config.bot.navigationCacheDir);
const temp = path.join(root, '_tmp');
const partUploadRoot = path.join(root, '_part_uploads');
fs.mkdirSync(temp, { recursive: true });
fs.mkdirSync(partUploadRoot, { recursive: true });

const upload = multer({
  dest: temp,
  limits: { files: MAX_CACHE_FILES, fileSize: MAX_CACHE_FILE_BYTES, fieldSize: 1024 },
  fileFilter: (_req, file, cb) => cb(null, /\.mvnav$/i.test(file.originalname)),
});
const archiveUpload = multer({
  dest: temp,
  limits: { files: 1, fileSize: MAX_ARCHIVE_BYTES },
  fileFilter: (_req, file, cb) => cb(null, /\.zip$/i.test(file.originalname)),
});
const partUpload = multer({
  dest: temp,
  limits: { files: 1, fileSize: MAX_UPLOAD_PART_BYTES },
  fileFilter: (_req, file, cb) => cb(null, /\.part\d{4}\.bin$/i.test(file.originalname)),
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

function validatePartManifest(input) {
  if (!input || input.format !== 'rabbit-navigation-cache-parts' || input.version !== 1)
    throw new UploadError(422, 'Unsupported navigation-cache part manifest');
  if (typeof input.archive_name !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}\.zip$/i.test(input.archive_name))
    throw new UploadError(422, 'Invalid archive name in part manifest');
  if (!Number.isSafeInteger(input.archive_size) || input.archive_size <= 0 ||
      input.archive_size > MAX_ARCHIVE_BYTES)
    throw new UploadError(422, 'Invalid archive size in part manifest');
  if (typeof input.archive_sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(input.archive_sha256))
    throw new UploadError(422, 'Invalid archive SHA-256 in part manifest');
  if (!Number.isInteger(input.part_count) || input.part_count <= 0 ||
      input.part_count > MAX_UPLOAD_PARTS || !Array.isArray(input.parts) ||
      input.parts.length !== input.part_count)
    throw new UploadError(422, `Part manifest must contain 1-${MAX_UPLOAD_PARTS} parts`);

  const parts = [...input.parts].sort((a, b) => a.index - b.index);
  let totalBytes = 0;
  const names = new Set();
  parts.forEach((part, offset) => {
    if (!part || part.index !== offset + 1)
      throw new UploadError(422, 'Part indexes must be contiguous and start at 1');
    if (typeof part.file_name !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}\.part\d{4}\.bin$/i.test(part.file_name))
      throw new UploadError(422, `Invalid filename for part ${offset + 1}`);
    if (!Number.isSafeInteger(part.byte_size) || part.byte_size <= 0 ||
        part.byte_size > MAX_UPLOAD_PART_BYTES)
      throw new UploadError(422, `Invalid size for part ${offset + 1}`);
    if (typeof part.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(part.sha256))
      throw new UploadError(422, `Invalid SHA-256 for part ${offset + 1}`);
    const key = part.file_name.toLowerCase();
    if (names.has(key)) throw new UploadError(422, `Duplicate part filename: ${part.file_name}`);
    names.add(key);
    totalBytes += part.byte_size;
  });
  if (totalBytes !== input.archive_size)
    throw new UploadError(422, 'Part sizes do not match the declared archive size');

  return {
    format: 'rabbit-navigation-cache-parts', version: 1,
    archive_name: input.archive_name,
    archive_size: input.archive_size,
    archive_sha256: input.archive_sha256.toLowerCase(),
    part_count: input.part_count,
    parts: parts.map((part) => ({ index: part.index, file_name: part.file_name,
      byte_size: part.byte_size, sha256: part.sha256.toLowerCase() })),
  };
}

function uploadSessionDirectory(uploadId) {
  if (!/^[0-9a-f]{32}$/.test(uploadId || ''))
    throw new UploadError(400, 'Invalid part-upload id');
  return path.join(partUploadRoot, uploadId);
}

function uploadPartPath(sessionDir, index) {
  return path.join(sessionDir, `part-${String(index).padStart(4, '0')}.bin`);
}

async function saveUploadSession(sessionDir, session) {
  const temporary = path.join(sessionDir, `manifest-${crypto.randomBytes(6).toString('hex')}.tmp`);
  const destination = path.join(sessionDir, 'manifest.json');
  await fs.promises.writeFile(temporary, JSON.stringify(session, null, 2), { mode: 0o600 });
  try {
    await fs.promises.rename(temporary, destination);
  } catch (error) {
    // Windows cannot rename over an existing file. Session manifests are small;
    // replace explicitly while retaining the temporary-write behavior.
    if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
    await fs.promises.rm(destination, { force: true });
    await fs.promises.rename(temporary, destination);
  }
}

async function loadUploadSession(serverId, uploadId, userId) {
  const sessionDir = uploadSessionDirectory(uploadId);
  let session;
  try {
    session = JSON.parse(await fs.promises.readFile(path.join(sessionDir, 'manifest.json'), 'utf8'));
  } catch (_) {
    throw new UploadError(404, 'Part-upload session not found or expired');
  }
  if (session.server_id !== serverId || session.user_id !== userId)
    throw new UploadError(403, 'Part-upload session does not belong to this server and administrator');
  return { sessionDir, session };
}

async function assertNotFinalizing(sessionDir, message = 'This upload is already being analyzed') {
  const lockPath = path.join(sessionDir, 'finalize.lock');
  try {
    const stat = await fs.promises.stat(lockPath);
    if (stat.mtimeMs >= Date.now() - PART_UPLOAD_TTL_MS)
      throw new UploadError(409, message);
    await fs.promises.rm(lockPath, { force: true });
  } catch (error) {
    if (error instanceof UploadError) throw error;
    if (error.code !== 'ENOENT') throw error;
  }
}

async function cleanupStalePartUploads() {
  let entries = [];
  try { entries = await fs.promises.readdir(partUploadRoot, { withFileTypes: true }); }
  catch (_) { return; }
  const cutoff = Date.now() - PART_UPLOAD_TTL_MS;
  await Promise.all(entries.filter((entry) => entry.isDirectory() && /^[0-9a-f]{32}$/.test(entry.name))
    .map(async (entry) => {
      const directory = path.join(partUploadRoot, entry.name);
      try {
        try {
          const lock = await fs.promises.stat(path.join(directory, 'finalize.lock'));
          if (lock.mtimeMs >= cutoff) return;
        } catch (_) { /* not being finalized */ }
        const stat = await fs.promises.stat(path.join(directory, 'manifest.json'));
        if (stat.mtimeMs < cutoff)
          await fs.promises.rm(directory, { recursive: true, force: true });
      } catch (_) {
        try {
          const stat = await fs.promises.stat(directory);
          if (stat.mtimeMs < cutoff)
            await fs.promises.rm(directory, { recursive: true, force: true });
        } catch (_) { /* already removed */ }
      }
    }));
}

async function assemblePartArchive(sessionDir, session, destination) {
  const output = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  const archiveHash = crypto.createHash('sha256');
  let archiveBytes = 0;
  try {
    for (const part of session.manifest.parts) {
      const partPath = uploadPartPath(sessionDir, part.index);
      const partHash = crypto.createHash('sha256');
      let partBytes = 0;
      for await (const chunk of fs.createReadStream(partPath)) {
        partHash.update(chunk);
        archiveHash.update(chunk);
        partBytes += chunk.length;
        archiveBytes += chunk.length;
        if (!output.write(chunk)) await once(output, 'drain');
      }
      if (partBytes !== part.byte_size || partHash.digest('hex') !== part.sha256)
        throw new UploadError(422, `Uploaded part ${part.index} failed its final integrity check`);
    }
    output.end();
    await finished(output);
  } catch (error) {
    output.destroy();
    throw error;
  }
  if (archiveBytes !== session.manifest.archive_size ||
      archiveHash.digest('hex') !== session.manifest.archive_sha256)
    throw new UploadError(422, 'Reassembled ZIP failed its size or SHA-256 check');
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

router.post('/:serverId/parts/start', requireSuperAdmin, async (req, res) => {
  try {
    const serverId = Number.parseInt(req.params.serverId, 10);
    await resolveServer(serverId);
    const manifest = validatePartManifest(req.body);
    await cleanupStalePartUploads();

    const uploadId = crypto.randomBytes(16).toString('hex');
    const sessionDir = uploadSessionDirectory(uploadId);
    await fs.promises.mkdir(sessionDir, { recursive: false, mode: 0o700 });
    const session = {
      upload_id: uploadId,
      server_id: serverId,
      user_id: req.session.user.id,
      created_at: new Date().toISOString(),
      manifest,
      received: {},
    };
    await saveUploadSession(sessionDir, session);
    res.status(201).json({ upload_id: uploadId, part_count: manifest.part_count,
      archive_size: manifest.archive_size, expires_in_seconds: PART_UPLOAD_TTL_MS / 1000 });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/:serverId/parts/:uploadId/:partIndex(\\d+)', requireSuperAdmin, async (req, res) => {
  let uploaded = null;
  try {
    const serverId = Number.parseInt(req.params.serverId, 10);
    const partIndex = Number.parseInt(req.params.partIndex, 10);
    if (!Number.isInteger(serverId) || serverId <= 0 || !Number.isInteger(partIndex))
      throw new UploadError(400, 'Invalid server id or part index');
    const { sessionDir, session } = await loadUploadSession(
      serverId, req.params.uploadId, req.session.user.id);
    await assertNotFinalizing(sessionDir);
    const expected = session.manifest.parts.find((part) => part.index === partIndex);
    if (!expected) throw new UploadError(404, 'Part is not present in this upload manifest');

    await receiveUpload(partUpload.single('part'), req, res);
    uploaded = req.file || null;
    if (!uploaded) throw new UploadError(422, `Select part ${partIndex}`);
    if (uploaded.originalname.toLowerCase() !== expected.file_name.toLowerCase())
      throw new UploadError(422, `Expected ${expected.file_name}, received ${uploaded.originalname}`);
    if (uploaded.size !== expected.byte_size)
      throw new UploadError(422, `Part ${partIndex} size does not match its manifest`);
    const sha256 = await hashFile(uploaded.path);
    if (sha256 !== expected.sha256)
      throw new UploadError(422, `Part ${partIndex} SHA-256 does not match its manifest`);

    const destination = uploadPartPath(sessionDir, partIndex);
    await fs.promises.rm(destination, { force: true });
    await fs.promises.rename(uploaded.path, destination);
    uploaded = null;
    session.received[String(partIndex)] = {
      byte_size: expected.byte_size, sha256, received_at: new Date().toISOString(),
    };
    await saveUploadSession(sessionDir, session);
    res.json({ upload_id: session.upload_id, part_index: partIndex,
      received_parts: Object.keys(session.received).length,
      part_count: session.manifest.part_count });
  } catch (error) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : (error.status || 500);
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'Upload part exceeds the 80 MiB server limit'
      : error.message;
    res.status(status).json({ error: message });
  } finally {
    if (uploaded) cleanUploads([uploaded]);
  }
});

router.post('/:serverId/parts/:uploadId/finalize', requireSuperAdmin, async (req, res) => {
  let sessionDir = null;
  let lockPath = null;
  let archivePath = null;
  let extractDir = null;
  let extracted = [];
  let published = false;
  try {
    const serverId = Number.parseInt(req.params.serverId, 10);
    const server = await resolveServer(serverId);
    const loaded = await loadUploadSession(serverId, req.params.uploadId, req.session.user.id);
    sessionDir = loaded.sessionDir;
    const session = loaded.session;
    const missing = session.manifest.parts
      .filter((part) => !session.received[String(part.index)])
      .map((part) => part.index);
    if (missing.length)
      throw new UploadError(409, `Upload is incomplete; missing parts: ${missing.join(', ')}`);

    lockPath = path.join(sessionDir, 'finalize.lock');
    try { await (await fs.promises.open(lockPath, 'wx', 0o600)).close(); }
    catch (error) {
      if (error.code === 'EEXIST')
        throw new UploadError(409, 'This upload is already being analyzed');
      throw error;
    }

    archivePath = path.join(sessionDir, 'assembled.zip');
    await fs.promises.rm(archivePath, { force: true });
    await assemblePartArchive(sessionDir, session, archivePath);
    extractDir = path.join(sessionDir, 'extracted');
    try {
      extracted = await extractCacheArchive(archivePath, extractDir);
    } catch (error) {
      throw new UploadError(422, `Invalid reassembled cache ZIP: ${error.message}`);
    }
    const result = await publishFiles(req, serverId, server, extracted);
    published = true;
    res.status(201).json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  } finally {
    cleanUploads(extracted);
    if (published && sessionDir) {
      await fs.promises.rm(sessionDir, { recursive: true, force: true });
    } else {
      if (extractDir) await fs.promises.rm(extractDir, { recursive: true, force: true });
      if (archivePath) await fs.promises.rm(archivePath, { force: true });
      if (lockPath) await fs.promises.rm(lockPath, { force: true });
    }
  }
});

router.delete('/:serverId/parts/:uploadId', requireSuperAdmin, async (req, res) => {
  try {
    const serverId = Number.parseInt(req.params.serverId, 10);
    const { sessionDir } = await loadUploadSession(
      serverId, req.params.uploadId, req.session.user.id);
    await assertNotFinalizing(sessionDir, 'Cannot discard an upload while it is being analyzed');
    await fs.promises.rm(sessionDir, { recursive: true, force: true });
    res.json({ message: 'Part-upload session discarded' });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
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
