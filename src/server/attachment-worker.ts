import { parentPort, workerData } from 'node:worker_threads';
import { AppError, invariant } from './errors.ts';
import { validateWordArchive } from './document-budget.ts';
import type { ParsedAttachment } from './attachment-parser.ts';

const textLimit = 512 * 1024;
function checkedText(text: string) {
  invariant(
    Buffer.byteLength(text, 'utf8') <= textLimit,
    'DOCUMENT_LIMIT',
    '提取后的文字超过 512 KiB，请拆分文件',
    413,
  );
  invariant(text.trim(), 'DOCUMENT_NO_TEXT', '未提取到可读文字；扫描件或图片文档需要先进行 OCR');
  return text;
}

export async function decodeAttachment(mime: string, bytes: Buffer): Promise<ParsedAttachment> {
  if (mime.startsWith('image/')) {
    const { default: sharp } = await import('sharp');
    sharp.concurrency(1);
    sharp.cache(false);
    try {
      const image = sharp(bytes, {
        animated: true,
        failOn: 'warning',
        limitInputPixels: 16 * 1024 * 1024,
      }).timeout({ seconds: 10 });
      const metadata = await image.metadata();
      const width = metadata.width,
        height = metadata.pageHeight ?? metadata.height,
        frames = metadata.pages ?? 1;
      invariant(
        width > 0 &&
          height > 0 &&
          width <= 8192 &&
          height <= 8192 &&
          frames <= 120 &&
          width * height * frames <= 16 * 1024 * 1024,
        'IMAGE_LIMIT',
        '图片边长最多 8192，最多 120 帧，所有帧合计不能超过 16777216 像素',
        413,
      );
      invariant('image/' + metadata.format === mime, 'IMAGE_INVALID', '图片格式与文件内容不符');
      // metadata() alone never proves pixel data is decodable.
      await image.raw().toBuffer();
      return { image: { width, height, frames } };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof Error && /pixel limit/i.test(error.message))
        throw new AppError('IMAGE_LIMIT', '图片所有帧合计不能超过 16777216 像素', 413);
      throw new AppError('IMAGE_INVALID', '图片无法完整解码，可能已损坏或被截断');
    }
  }
  try {
    if (mime === 'application/pdf') {
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const task = getDocument({
        data: Uint8Array.from(bytes),
        useSystemFonts: false,
        useWorkerFetch: false,
        disableFontFace: true,
        verbosity: 0,
        stopAtErrors: true,
      });
      try {
        const doc = await task.promise;
        invariant(doc.numPages <= 200, 'DOCUMENT_LIMIT', 'PDF 最多 200 页，请拆分文件', 413);
        const pages: string[] = [];
        let size = 0;
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          const reader = page.streamTextContent().getReader();
          let text = '';
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              for (const item of chunk.value.items)
                if ('str' in item) {
                  // PDF.js supplies explicit spaces and line endings. Font switches are not spaces.
                  // Some embedded CJK fonts map identical-looking glyphs to Kangxi radical codepoints.
                  const part =
                    item.str.replace(/[\u2f00-\u2fd5]/g, (char: string) => char.normalize('NFKC')) +
                    (item.hasEOL ? '\n' : '');
                  size += Buffer.byteLength(part);
                  invariant(
                    size <= textLimit,
                    'DOCUMENT_LIMIT',
                    '提取后的文字超过 512 KiB，请拆分文件',
                    413,
                  );
                  text += part;
                }
            }
          } finally {
            await reader.cancel().catch(() => {});
            page.cleanup();
          }
          pages.push(text.trim());
        }
        const text = checkedText(pages.join('\n\n'));
        const empty = pages.filter((x) => !x).length;
        return {
          text,
          extraction: {
            format: 'pdf',
            pages: doc.numPages,
            characters: text.length,
            warnings: empty ? [`${empty} 页没有可提取文字，可能是空白页或扫描图片`] : [],
          },
        };
      } finally {
        await task.destroy();
      }
    }
    validateWordArchive(bytes);
    const { default: mammoth } = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer: bytes });
    invariant(
      !result.messages.some((x) => x.type === 'error'),
      'DOCUMENT_INVALID',
      'Word 文档部分内容无法读取，请检查原文件',
    );
    const text = checkedText(result.value);
    return {
      text,
      extraction: {
        format: 'docx',
        characters: text.length,
        warnings: result.messages.length ? ['部分格式或对象未转换，仅提取可读取的文字'] : [],
      },
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && error.name === 'PasswordException')
      throw new AppError('DOCUMENT_PASSWORD', 'PDF 已加密，请先提供解除密码保护的副本');
    throw new AppError(
      'DOCUMENT_INVALID',
      '文档无法读取，可能已损坏、加密或不是受支持的 PDF / DOCX',
    );
  }
}

if (parentPort) {
  try {
    parentPort.postMessage({
      data: await decodeAttachment(workerData.mime, Buffer.from(workerData.bytes)),
    });
  } catch (error) {
    const failure =
      error instanceof AppError
        ? error
        : new AppError('ATTACHMENT_PROCESSING', '附件处理失败，请检查文件');
    parentPort.postMessage({
      error: { code: failure.code, message: failure.message, status: failure.status },
    });
  }
}
