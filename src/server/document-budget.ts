import { crc32, inflateRawSync } from 'node:zlib';
import { invariant } from './errors.ts';

// Validate both declared and actual expansion before handing the archive to the Word reader.
export function validateWordArchive(bytes: Buffer) {
  const bad = (condition: unknown) =>
    invariant(condition, 'DOCUMENT_INVALID', 'Word 文件损坏或使用了不支持的压缩格式');
  const limit = (condition: unknown) =>
    invariant(
      condition,
      'DOCUMENT_LIMIT',
      'Word 解压内容不能超过 16 MiB、单项不能超过 8 MiB，最多 1024 项',
      413,
    );
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65557); end--)
    if (
      bytes.readUInt32LE(end) === 0x06054b50 &&
      end + 22 + bytes.readUInt16LE(end + 20) === bytes.length
    )
      break;
  bad(end >= 0 && bytes.length >= 22);
  bad(bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0);
  const count = bytes.readUInt16LE(end + 10),
    directorySize = bytes.readUInt32LE(end + 12),
    start = bytes.readUInt32LE(end + 16);
  bad(count === bytes.readUInt16LE(end + 8) && start + directorySize === end);
  limit(count > 0 && count <= 1024);
  let offset = start,
    total = 0;
  const names = new Set<string>();
  const occupied: [number, number][] = [];
  for (let n = 0; n < count; n++) {
    bad(offset + 46 <= end && bytes.readUInt32LE(offset) === 0x02014b50);
    const flags = bytes.readUInt16LE(offset + 8),
      method = bytes.readUInt16LE(offset + 10),
      checksum = bytes.readUInt32LE(offset + 16),
      compressed = bytes.readUInt32LE(offset + 20),
      expanded = bytes.readUInt32LE(offset + 24),
      nameSize = bytes.readUInt16LE(offset + 28),
      extra = bytes.readUInt16LE(offset + 30),
      comment = bytes.readUInt16LE(offset + 32),
      local = bytes.readUInt32LE(offset + 42);
    bad(!(flags & 1) && [0, 8].includes(method) && bytes.readUInt16LE(offset + 34) === 0);
    bad(offset + 46 + nameSize + extra + comment <= end);
    const label = bytes.subarray(offset + 46, offset + 46 + nameSize),
      name = label.toString('utf8');
    bad(
      name.length > 0 &&
        !names.has(name) &&
        !name.includes('\\') &&
        !name.startsWith('/') &&
        !name.split('/').includes('..') &&
        !/[\x00-\x1f]/.test(name),
    );
    names.add(name);
    total += expanded;
    limit(expanded <= 8 * 1024 * 1024 && total <= 16 * 1024 * 1024);
    bad(
      local + 30 <= start &&
        bytes.readUInt32LE(local) === 0x04034b50 &&
        bytes.readUInt16LE(local + 8) === method &&
        bytes.readUInt16LE(local + 6) === flags,
    );
    const localNameSize = bytes.readUInt16LE(local + 26),
      localExtra = bytes.readUInt16LE(local + 28),
      body = local + 30 + localNameSize + localExtra;
    bad(
      localNameSize === nameSize &&
        bytes.subarray(local + 30, local + 30 + localNameSize).equals(label) &&
        body + compressed <= start,
    );
    bad(occupied.every(([a, b]) => body + compressed <= a || local >= b));
    occupied.push([local, body + compressed]);
    const raw = bytes.subarray(body, body + compressed);
    const content =
      method === 0
        ? raw
        : inflateRawSync(raw, {
            maxOutputLength: Math.max(1, Math.min(expanded + 1, 8 * 1024 * 1024)),
          });
    bad(content.length === expanded && crc32(content) === checksum);
    if (name.endsWith('.xml') || name.endsWith('.rels')) {
      const text = content.toString('utf8');
      bad(!/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text));
    }
    offset += 46 + nameSize + extra + comment;
  }
  bad(offset === end && names.has('word/document.xml') && names.has('[Content_Types].xml'));
}
