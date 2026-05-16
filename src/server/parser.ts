import yauzl from 'yauzl';
import { mkdirSync, rmSync, existsSync, createReadStream, createWriteStream, readdirSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { Message } from './database.js';

export type MediaType = 'image' | 'video' | 'audio' | 'document' | 'unknown';

export interface ExtractionResult {
  chatId: string;
  extractDir: string;
  txtFile: string;
  messages: Message[];
  mediaFiles: string[];
}

// Media type detection based on file extension
const MEDIA_TYPES: Record<string, MediaType> = {
  '.jpg': 'image',
  '.jpeg': 'image',
  '.png': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.mp4': 'video',
  '.mov': 'video',
  '.avi': 'video',
  '.mkv': 'video',
  '.webm': 'video',
  '.mp3': 'audio',
  '.m4a': 'audio',
  '.wav': 'audio',
  '.ogg': 'audio',
  '.opus': 'audio',
  '.pdf': 'document',
  '.doc': 'document',
  '.docx': 'document',
  '.xls': 'document',
  '.xlsx': 'document',
  '.ppt': 'document',
  '.pptx': 'document',
};

function getMediaType(filename: string): MediaType {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  return MEDIA_TYPES[ext] || 'unknown';
}

// Clean hidden Unicode characters from text
function cleanText(text: string): string {
  return text.replace(/[‎‏‪-‮⁦-⁩]/g, '').trim();
}

// WhatsApp date formats:
// 1) M/D/YYYY H:MM:SS am/pm - Sender: Message
// 2) M/D/YY, H:MM AM/PM - Sender: Message  (_chat.txt format)
// 3) [M/D/YY, H:MM:SS AM/PM] Sender: Message (bracket format)
// 4) [M/D/YYYY 下午/上午 H:MM:SS] Sender: Message (Chinese format)
const MESSAGE_REGEXES = [
  // Format: 5/7/2022 6:56:06 pm - Sender: Message
  /^(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]m)?)\s+-\s+(.*?)(?::\s*(.*))?$/i,
  // Format: 12/25/22, 10:00 AM - +1 234 567 8900: Message
  /^(\d{1,2}\/\d{1,2}\/\d{2}),?\s+(\d{1,2}:\d{2}(?::\d{2})?\s*[ap]m)\s+-\s+(.*?)(?::\s*(.*))?$/i,
  // Format: [12/25/22, 10:00:00 AM] Sender: Message
  /^\[(\d{1,2}\/\d{1,2}\/\d{2}),?\s+(\d{1,2}:\d{2}(?::\d{2})?\s*[ap]m)\]\s+(.*?)(?::\s*(.*))?$/i,
  // Format: [9/8/2024 下午11:02:13] Group with Riza: Message (Chinese WhatsApp format)
  /^\[(\d{1,2}\/\d{1,2}\/\d{4})\s+(上午|下午|am|pm)(\d{1,2}:\d{2}:\d{2})\]\s+([^:]+):\s*(.*)$/i,
  // Format: [9/8/2024 下午11:02:13] Message (system message without colon)
  /^\[(\d{1,2}\/\d{1,2}\/\d{4})\s+(上午|下午|am|pm)(\d{1,2}:\d{2}:\d{2})\]\s+(.+)$/i,
];

function parseWhatsAppText(textContent: string, chatId: string): Message[] {
  const lines = textContent.split(/\r?\n/);
  const messages: Message[] = [];
  let position = 0;

  for (const line of lines) {
    const cleanedLine = cleanText(line);
    if (!cleanedLine) continue;

    let match = null;
    let matchedRegexIndex = -1;

    for (let i = 0; i < MESSAGE_REGEXES.length; i++) {
      match = cleanedLine.match(MESSAGE_REGEXES[i]);
      if (match) {
        matchedRegexIndex = i;
        break;
      }
    }

    if (!match) continue;

    let date: string;
    let time: string;
    let sender: string | null;
    let text: string;
    let isSystemMessage: boolean;

    // Handle different regex formats
    if (matchedRegexIndex === 3) {
      // Chinese format with colon: [9/8/2024 下午11:02:13] Sender: Message
      [, date, , time, sender, text] = match;
      isSystemMessage = false;
    } else if (matchedRegexIndex === 4) {
      // Chinese format without colon: [9/8/2024 下午11:02:13] Message (system)
      [, date, , time, text] = match;
      sender = null;
      isSystemMessage = true;
    } else {
      // Original formats: date, time, senderOrSystem, message
      const [, d, t, senderOrSystem, message] = match;
      date = d;
      time = t;
      isSystemMessage = message === undefined;
      sender = isSystemMessage ? null : senderOrSystem;
      text = isSystemMessage ? senderOrSystem : (message || '');
    }

    // Extract media information if present
    let mediaFilename: string | null = null;
    let mediaType: MediaType | null = null;
    let cleanMessage = text;

    // Check for (附件檔案) or (file attached) suffix
    const mediaMatch = text.match(/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\s*(?:\(附件檔案\)|\(file attached\))?$/i);
    if (mediaMatch) {
      mediaFilename = mediaMatch[1];
      mediaType = getMediaType(mediaFilename);
      cleanMessage = text.substring(0, mediaMatch.index).trim() || '<Media omitted>';
    }

    // Check for Chinese media omitted indicators
    if (cleanMessage.endsWith('圖片已略去') || cleanMessage.endsWith('视频已略去') ||
        cleanMessage.endsWith('音频已略去') || cleanMessage.endsWith('文件已略去')) {
      cleanMessage = cleanMessage.replace(/(圖片|视频|音频|文件)已略去$/, '<Media omitted>');
    }

    messages.push({
      chatId,
      position: position++,
      date,
      time,
      sender,
      text: cleanMessage,
      isSystemMessage,
      mediaFilename,
      mediaType,
    });
  }

  return messages;
}

// Parse a standalone txt file
export function parseTextFile(textFilePath: string, chatId: string): Message[] {
  const textContent = readFileSync(textFilePath, 'utf-8');
  return parseWhatsAppText(textContent, chatId);
}

// Open a zip file using yauzl (streaming, supports files > 2 GiB)
function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    console.log(`[PARSER] openZip: ${zipPath}`);
    yauzl.open(zipPath, { lazyEntries: false }, (err, zipfile) => {
      if (err) {
        console.error(`[PARSER] openZip error:`, err);
        reject(err);
      } else {
        console.log(`[PARSER] openZip success, zipfile:`, zipfile ? 'yes' : 'no');
        if (zipfile) {
          console.log(`[PARSER]   entryCount: ${zipfile.entryCount}`);
        }
        resolve(zipfile);
      }
    });
  });
}

// Read an entry from the zip as a string
function readEntryToString(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<string> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err: Error | null, readStream: NodeJS.ReadableStream | undefined) => {
      if (err) { reject(err); return; }
      const chunks: Buffer[] = [];
      readStream!.on('data', (chunk: Buffer) => chunks.push(chunk));
      readStream!.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      readStream!.on('error', reject);
    });
  });
}

// Extract a single entry from zip to disk
function extractEntry(zipfile: yauzl.ZipFile, entry: yauzl.Entry, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err: Error | null, readStream: NodeJS.ReadableStream | undefined) => {
      if (err) { reject(err); return; }
      const writeStream = createWriteStream(destPath);
      readStream!.pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      readStream!.on('error', reject);
    });
  });
}

// Extract zip file - only reads txt file, lists media files (streaming, no size limit)
export async function extractAndParseZip(zipPath: string, tempDir: string): Promise<ExtractionResult> {
  const filename = basename(zipPath);
  const baseName = filename.replace(/\.zip$/i, '');
  const chatId = baseName;
  const extractDir = join(tempDir, chatId);

  console.log(`[PARSER] extractAndParseZip: ${filename}`);
  console.log(`[PARSER]   zipPath: ${zipPath}`);
  console.log(`[PARSER]   tempDir: ${tempDir}`);
  console.log(`[PARSER]   extractDir: ${extractDir}`);

  // Clean up existing extraction if present
  if (existsSync(extractDir)) {
    console.log(`[PARSER]   Cleaning existing extraction dir...`);
    rmSync(extractDir, { recursive: true, force: true });
  }
  mkdirSync(extractDir, { recursive: true });

  console.log(`[PARSER]   Opening zip file...`);
  const zipfile = await openZip(zipPath);
  console.log(`[PARSER]   Zip opened, reading entries...`);
  console.log(`[PARSER]   zipfile object:`, { entryCount: zipfile.entryCount });

  return new Promise((resolve, reject) => {
    let txtFile = '';
    let txtContent = '';
    const mediaFiles: string[] = [];
    let pendingReads = 0;
    let entryCount = 0;
    let finished = false;

    const finish = () => {
      if (finished) {
        console.log(`[PARSER]   Finish called multiple times, skipping`);
        return;
      }
      finished = true;
      console.log(`[PARSER]   Finish called. txtFile: ${txtFile}, txtContent length: ${txtContent.length}, mediaFiles: ${mediaFiles.length}`);

      if (!txtFile) {
        console.error(`[PARSER]   No txt file found in zip! Entries seen: ${entryCount}`);
        reject(new Error(`No .txt file found in zip archive: ${filename}`));
        return;
      }

      console.log(`[PARSER]   Parsing ${txtContent.length} bytes of text...`);
      const messages = parseWhatsAppText(txtContent, chatId);
      console.log(`[PARSER]   Parsed ${messages.length} messages`);

      resolve({
        chatId,
        extractDir,
        txtFile,
        messages,
        mediaFiles,
      });
    };

    zipfile.on('entry', (entry: yauzl.Entry) => {
      entryCount++;

      const entryName = basename(entry.fileName);

      console.log(`[PARSER]   Entry ${entryCount}: ${entry.fileName} (basename: ${entryName})`);

      // Skip directories and hidden files
      if (/\/$/.test(entry.fileName) || entryName.startsWith('.')) {
        console.log(`[PARSER]     Skipping (directory or hidden)`);
        return;
      }

      if (entryName.endsWith('.txt')) {
        // Read txt content into memory (small file)
        txtFile = entryName;
        console.log(`[PARSER]     Reading txt file: ${entryName}`);
        pendingReads++;
        readEntryToString(zipfile, entry)
          .then(content => {
            txtContent = content;
            console.log(`[PARSER]     Read ${content.length} bytes from txt file`);
            pendingReads--;
            if (pendingReads === 0) finish();
          })
          .catch(err => {
            console.error(`[PARSER]     Error reading txt:`, err);
            pendingReads--;
            if (pendingReads === 0) finish();
          });
      } else {
        // Just track media files, don't extract yet
        mediaFiles.push(entryName);
        console.log(`[PARSER]     Tracking as media file`);
      }
    });

    zipfile.on('end', () => {
      console.log(`[PARSER]   Zip entry end event. Total entries seen: ${entryCount}, pendingReads: ${pendingReads}`);
      // All entries processed, finish if no async reads pending
      if (pendingReads === 0 && !finished) finish();
    });

    zipfile.on('error', (err: Error) => {
      if (!finished) {
        console.error(`[PARSER]   Zip error for ${filename}:`, err);
        console.error(`[PARSER]   Error stack:`, err.stack);
        reject(new Error(`Zip error for ${filename}: ${err.message}`));
      }
    });

    // Add a timeout in case the zip file is malformed
    setTimeout(() => {
      if (!finished) {
        console.error(`[PARSER]   TIMEOUT after 30 seconds. entries: ${entryCount}, pendingReads: ${pendingReads}`);
        console.error(`[PARSER]   Forcing finish...`);
        finish();
      }
    }, 30000);
  });
}

// Extract a specific file from a zip to the given directory (on-demand for media)
export async function extractFileFromZip(zipPath: string, targetFilename: string, tempDir: string): Promise<string> {
  if (!targetFilename) {
    throw new Error('targetFilename is required');
  }

  const filename = basename(zipPath);
  const baseName = filename.replace(/\.zip$/i, '');
  const extractDir = join(tempDir, baseName);

  if (!existsSync(extractDir)) {
    mkdirSync(extractDir, { recursive: true });
  }

  const destPath = join(extractDir, targetFilename);
  if (existsSync(destPath)) {
    return destPath;
  }

  console.log(`[EXTRACT] Extracting ${targetFilename} from ${zipPath}`);
  const zipfile = await openZip(zipPath);

  return new Promise((resolve, reject) => {
    let found = false;

    zipfile.on('entry', (entry: yauzl.Entry) => {
      const entryName = basename(entry.fileName);
      console.log(`[EXTRACT] Checking entry: ${entryName} vs ${targetFilename}`);

      if (entryName === targetFilename) {
        found = true;
        extractEntry(zipfile, entry, destPath)
          .then(() => resolve(destPath))
          .catch(err => reject(err));
      }
    });

    zipfile.on('end', () => {
      if (!found) {
        reject(new Error(`File "${targetFilename}" not found in zip: ${filename}`));
      }
    });

    zipfile.on('error', (err: Error) => {
      reject(new Error(`Zip error extracting ${targetFilename} from ${filename}: ${err.message}`));
    });
  });
}

// Clean up extraction directory
export function cleanupExtraction(extractDir: string): void {
  if (existsSync(extractDir)) {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

// Clean up all temp directories
export function cleanupAllTemp(tempDir: string): void {
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  mkdirSync(tempDir, { recursive: true });
}
