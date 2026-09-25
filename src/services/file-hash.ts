import crypto from "node:crypto";
import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fsp from "node:fs/promises";

const HASH_CHUNK_SIZE = 1024 * 1024;

/**
 * Identifies the byte coverage of the hashes written by duplicate detection.
 * The value is intentionally kept separate from the digest itself so callers
 * cannot mistake a historical sampled digest for a full-file digest.
 */
export const FULL_FILE_HASH_VERSION = "sha256-full-v1";
export const SAMPLE_FILE_HASH_VERSION = "sha256-sample-v1";

function sameFileMetadata(before: fs.Stats, after: fs.Stats): boolean {
  return (
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

function readSyncFully(fd: number, buffer: Buffer, position: number): number {
  let bytesRead = 0;
  while (bytesRead < buffer.length) {
    const count = fs.readSync(
      fd,
      buffer,
      bytesRead,
      buffer.length - bytesRead,
      position + bytesRead
    );
    if (count <= 0) {
      break;
    }
    bytesRead += count;
  }
  return bytesRead;
}

async function readFully(
  handle: FileHandle,
  buffer: Buffer,
  position: number
): Promise<number> {
  let bytesRead = 0;
  while (bytesRead < buffer.length) {
    const { bytesRead: count } = await handle.read(
      buffer,
      bytesRead,
      buffer.length - bytesRead,
      position + bytesRead
    );
    if (count <= 0) {
      break;
    }
    bytesRead += count;
  }
  return bytesRead;
}

function updateSampleHash(hash: crypto.Hash, fd: number, size: number): void {
  if (size <= 8192) {
    const buffer = Buffer.alloc(size);
    if (size > 0) {
      const bytesRead = readSyncFully(fd, buffer, 0);
      if (bytesRead !== size) {
        throw new Error("File changed while sampling");
      }
    }
    hash.update(buffer);
    return;
  }
  const head = Buffer.alloc(4096);
  const headRead = readSyncFully(fd, head, 0);
  const tail = Buffer.alloc(4096);
  const tailRead = readSyncFully(fd, tail, size - tail.length);
  if (headRead !== head.length || tailRead !== tail.length) {
    throw new Error("File changed while sampling");
  }
  hash.update(head);
  hash.update(tail);
  const sizeBuffer = Buffer.alloc(8);
  sizeBuffer.writeBigInt64LE(BigInt(size));
  hash.update(sizeBuffer);
}

/** Fast candidate filter. Never use this digest as proof of exact equality. */
export function computeSampleFileHashSync(filePath: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const before = fs.fstatSync(fd);
    const hash = crypto.createHash("sha256");
    updateSampleHash(hash, fd, before.size);
    const after = fs.fstatSync(fd);
    return sameFileMetadata(before, after) ? hash.digest("hex") : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close failures after the sample result is known.
      }
    }
  }
}

/** Async counterpart used while building the full duplicate scan candidates. */
export async function computeSampleFileHash(
  filePath: string
): Promise<string | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await fsp.open(filePath, "r");
    const before = await handle.stat();
    const hash = crypto.createHash("sha256");
    if (before.size <= 8192) {
      const buffer = Buffer.alloc(before.size);
      if (before.size > 0) {
        const bytesRead = await readFully(handle, buffer, 0);
        if (bytesRead !== before.size) {
          return null;
        }
      }
      hash.update(buffer);
    } else {
      const head = Buffer.alloc(4096);
      const headRead = await readFully(handle, head, 0);
      const tail = Buffer.alloc(4096);
      const tailRead = await readFully(handle, tail, before.size - tail.length);
      if (headRead !== head.length || tailRead !== tail.length) {
        return null;
      }
      hash.update(head);
      hash.update(tail);
      const sizeBuffer = Buffer.alloc(8);
      sizeBuffer.writeBigInt64LE(BigInt(before.size));
      hash.update(sizeBuffer);
    }
    const after = await handle.stat();
    return sameFileMetadata(before, after) ? hash.digest("hex") : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function getFileModifiedAt(
  filePath: string
): Promise<number | null> {
  try {
    return (await fsp.stat(filePath)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Computes a SHA-256 digest over every byte in a file.
 *
 * Duplicate detection used to hash only the first and last 4096 bytes for
 * large files. That is a useful candidate filter, but it is not an exact file
 * identity. This helper deliberately streams the complete file and rejects a
 * file whose metadata changes while it is being read.
 */
export function computeFullFileHashSync(filePath: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const before = fs.fstatSync(fd);
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_SIZE);
    let position = 0;

    while (position < before.size) {
      const bytesRead = fs.readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, before.size - position),
        position
      );
      if (bytesRead <= 0) {
        return null;
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }

    const after = fs.fstatSync(fd);
    return sameFileMetadata(before, after) ? hash.digest("hex") : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // The original read error is the useful result for callers.
      }
    }
  }
}

/**
 * Compares two files byte-for-byte. This is the final exactness check after
 * equal-size and equal-hash candidate filtering; a digest alone is not used
 * as the product-level definition of an exact duplicate.
 */
export function filesHaveSameBytesSync(
  firstPath: string,
  secondPath: string
): boolean {
  let firstFd: number | undefined;
  let secondFd: number | undefined;
  try {
    firstFd = fs.openSync(firstPath, "r");
    secondFd = fs.openSync(secondPath, "r");
    const firstBefore = fs.fstatSync(firstFd);
    const secondBefore = fs.fstatSync(secondFd);
    if (firstBefore.size !== secondBefore.size) {
      return false;
    }

    const firstBuffer = Buffer.allocUnsafe(HASH_CHUNK_SIZE);
    const secondBuffer = Buffer.allocUnsafe(HASH_CHUNK_SIZE);
    let position = 0;
    while (position < firstBefore.size) {
      const requested = Math.min(
        firstBuffer.length,
        firstBefore.size - position
      );
      const firstRead = readSyncFully(
        firstFd,
        firstBuffer.subarray(0, requested),
        position
      );
      const secondRead = readSyncFully(
        secondFd,
        secondBuffer.subarray(0, requested),
        position
      );
      if (
        firstRead !== requested ||
        secondRead !== requested ||
        !firstBuffer
          .subarray(0, requested)
          .equals(secondBuffer.subarray(0, requested))
      ) {
        return false;
      }
      position += requested;
    }

    return (
      sameFileMetadata(firstBefore, fs.fstatSync(firstFd)) &&
      sameFileMetadata(secondBefore, fs.fstatSync(secondFd))
    );
  } catch {
    return false;
  } finally {
    if (firstFd !== undefined) {
      try {
        fs.closeSync(firstFd);
      } catch {
        // Ignore close failures after the comparison result is known.
      }
    }
    if (secondFd !== undefined) {
      try {
        fs.closeSync(secondFd);
      } catch {
        // Ignore close failures after the comparison result is known.
      }
    }
  }
}

/** Async counterpart used by the Electron IPC scan so file I/O does not block
 * the main process while the full hash is being calculated. */
export async function computeFullFileHash(
  filePath: string
): Promise<string | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await fsp.open(filePath, "r");
    const before = await handle.stat();
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_SIZE);
    let position = 0;

    while (position < before.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - position),
        position
      );
      if (bytesRead <= 0) {
        return null;
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }

    const after = await handle.stat();
    return sameFileMetadata(before, after) ? hash.digest("hex") : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Async byte comparison used for the final exact duplicate confirmation. */
export async function filesHaveSameBytes(
  firstPath: string,
  secondPath: string,
  assertCurrent?: () => void
): Promise<boolean> {
  let firstHandle: FileHandle | undefined;
  let secondHandle: FileHandle | undefined;
  try {
    firstHandle = await fsp.open(firstPath, "r");
    secondHandle = await fsp.open(secondPath, "r");
    const [firstBefore, secondBefore] = await Promise.all([
      firstHandle.stat(),
      secondHandle.stat(),
    ]);
    if (firstBefore.size !== secondBefore.size) {
      return false;
    }

    const firstBuffer = Buffer.allocUnsafe(HASH_CHUNK_SIZE);
    const secondBuffer = Buffer.allocUnsafe(HASH_CHUNK_SIZE);
    let position = 0;
    while (position < firstBefore.size) {
      assertCurrent?.();
      const requested = Math.min(
        firstBuffer.length,
        firstBefore.size - position
      );
      const [firstRead, secondRead] = await Promise.all([
        readFully(firstHandle, firstBuffer.subarray(0, requested), position),
        readFully(secondHandle, secondBuffer.subarray(0, requested), position),
      ]);
      if (
        firstRead !== requested ||
        secondRead !== requested ||
        !firstBuffer
          .subarray(0, requested)
          .equals(secondBuffer.subarray(0, requested))
      ) {
        return false;
      }
      position += requested;
    }

    assertCurrent?.();
    const [firstAfter, secondAfter] = await Promise.all([
      firstHandle.stat(),
      secondHandle.stat(),
    ]);
    return (
      sameFileMetadata(firstBefore, firstAfter) &&
      sameFileMetadata(secondBefore, secondAfter)
    );
  } catch {
    assertCurrent?.();
    return false;
  } finally {
    await Promise.all([
      firstHandle?.close().catch(() => undefined),
      secondHandle?.close().catch(() => undefined),
    ]);
  }
}
