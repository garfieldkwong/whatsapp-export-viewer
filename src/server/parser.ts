import yauzl from 'yauzl';
import { mkdirSync, rmSync, existsSync, createReadStream, createWriteStream, readdirSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { Message } from './database.js';
import logger from './logger.js';

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

// Parse WhatsApp date string to Unix timestamp
function parseDateTime(dateStr: string, timeStr: string): number {
  let month: number, day: number, year: number;

  // Parse date string
  const dateParts = dateStr.split('/');
  if (dateParts.length === 3) {
    // Format: M/D/YYYY or M/D/YY
    month = parseInt(dateParts[0], 10);
    day = parseInt(dateParts[1], 10);
    let yearStr = dateParts[2];

    // Handle 2-digit years (00-99)
    if (yearStr.length === 2) {
      const yearNum = parseInt(yearStr, 10);
      // Years 00-99: if > current year's last 2 digits, assume 1900s, else 2000s
      const currentYear = new Date().getFullYear();
      const currentYearSuffix = currentYear % 100;
      if (yearNum > currentYearSuffix) {
        year = 1900 + yearNum;
      } else {
        year = 2000 + yearNum;
      }
    } else {
      year = parseInt(yearStr, 10);
    }
  } else {
    // Fallback to current date if parsing fails
    return Date.now();
  }

  // Parse time string
  let hours: number, minutes: number, seconds: number = 0;
  let isPM = false;

  // Remove spaces and lowercase for matching
  const timeLower = timeStr.toLowerCase().trim();

  // Check for AM/PM indicator
  if (timeLower.includes('pm')) {
    isPM = true;
  }

  // Extract time parts (handle formats like "6:56:06 pm", "10:00 AM", "11:02:13")
  const timeMatch = timeLower.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (timeMatch) {
    hours = parseInt(timeMatch[1], 10);
    minutes = parseInt(timeMatch[2], 10);
    if (timeMatch[3]) {
      seconds = parseInt(timeMatch[3], 10);
    }

    // Convert to 24-hour format
    if (isPM && hours !== 12) {
      hours += 12;
    } else if (!isPM && hours === 12) {
      hours = 0;
    }
  } else {
    // Fallback to midnight if time parsing fails
    hours = 0;
    minutes = 0;
    seconds = 0;
  }

  // Create Date object and return timestamp
  // Note: Date constructor uses 0-based month (0=Jan, 1=Feb, etc.)
  return new Date(year, month - 1, day, hours, minutes, seconds).getTime();
}

// WhatsApp date formats:
// 1) M/D/YYYY H:MM:SS am/pm - Sender: Message
// 2) M/D/YY, H:MM AM/PM - Sender: Message  (_chat.txt format)
// 3) [M/D/YY, H:MM:SS AM/PM] Sender: Message (bracket format)
// 4) [M/D/YYYY 下午/上午 H:MM:SS] Sender: Message (Chinese format)
// 5) M/D/YY H:MM - Sender: Message (no am/pm)
const MESSAGE_REGEXES = [
  // Format: 5/7/2022 6:56:06 pm - Sender: Message
  /^(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]m)?)\s+-\s+(.*?)(?::\s*(.*))?$/i,
  // Format: 12/25/22, 10:00 AM - +1 234 567 8900: Message
  /^(\d{1,2}\/\d{1,2}\/\d{2}),?\s+(\d{1,2}:\d{2}(?::\d{2})?\s*[ap]m)\s+-\s+(.*?)(?::\s*(.*))?$/i,
  // Format: 12/25/22, 10:00 - +1 234 567 8900: Message (no am/pm)
  /^(\d{1,2}\/\d{1,2}\/\d{2}),?\s+(\d{1,2}:\d{2}(?::\d{2})?)\s+-\s+(.*?)(?::\s*(.*))?$/i,
  // Format: [12/25/22, 10:00:00 AM] Sender: Message
  /^\[(\d{1,2}\/\d{1,2}\/\d{2}),?\s+(\d{1,2}:\d{2}(?::\d{2})?\s*[ap]m)\]\s+(.*?)(?::\s*(.*))?$/i,
  // Format: [9/8/2024 下午11:02:13] Group with Riza: Message (Chinese WhatsApp format)
  /^\[(\d{1,2}\/\d{1,2}\/\d{4})\s+(上午|下午|am|pm)(\d{1,2}:\d{2}:\d{2})\]\s+([^:]+):\s*(.*)$/i,
  // Format: [9/8/2024, 下午11:02:13] Group with Riza: Message (Chinese format with comma)
  /^\[(\d{1,2}\/\d{1,2}\/\d{4}),?\s+(上午|下午|am|pm)\s*(\d{1,2}:\d{2}:\d{2})\]\s+([^:]+):\s*(.*)$/i,
  // Format: [9/8/2024 下午11:02:13] Message (system message without colon)
  /^\[(\d{1,2}\/\d{1,2}\/\d{4})\s+(上午|下午|am|pm)(\d{1,2}:\d{2}:\d{2})\]\s+(.+)$/i,
];

function parseWhatsAppText(textContent: string, chatId: string, availableMediaFiles: string[] = []): Message[] {
  const lines = textContent.split(/\r?\n/);
  const messages: Message[] = [];
  let position = 0;

  // Index media files for quick lookup by type
  const mediaFilesByType: Record<MediaType, string[]> = {
    image: [],
    video: [],
    audio: [],
    document: [],
    unknown: [],
  };

  // Track used media files to avoid duplicates
  const usedMediaFiles = new Set<string>();

  for (const file of availableMediaFiles) {
    const type = getMediaType(file);
    mediaFilesByType[type].push(file);
    mediaFilesByType.unknown.push(file); // Also add to unknown for fallback
  }

  for (let i = 0; i < lines.length; i++) {
    const cleanedLine = cleanText(lines[i]);
    if (!cleanedLine) continue;

    let match = null;
    let matchedRegexIndex = -1;

    for (let j = 0; j < MESSAGE_REGEXES.length; j++) {
      match = cleanedLine.match(MESSAGE_REGEXES[j]);
      if (match) {
        matchedRegexIndex = j;
        break;
      }
    }

    if (!match) {
      // This line doesn't start a new message — append to the previous one
      if (messages.length > 0) {
        messages[messages.length - 1].text += '\n' + cleanedLine;
      }
      continue;
    }

    let date: string;
    let time: string;
    let sender: string | null;
    let text: string;
    let isSystemMessage: boolean;

    // Handle different regex formats
    if (matchedRegexIndex === 4 || matchedRegexIndex === 5) {
      // Chinese format with colon: [9/8/2024 下午11:02:13] Sender: Message
      // Index 4: [9/8/2024 下午11:02:13] Sender: Message
      // Index 5: [9/8/2024, 下午11:02:13] Sender: Message (with comma)
      [, date, , time, sender, text] = match;
      isSystemMessage = false;
    } else if (matchedRegexIndex === 6) {
      // Chinese format without colon: [9/8/2024 下午11:02:13] Message (system)
      [, date, , time, text] = match;
      sender = null;
      isSystemMessage = true;
    } else {
      // Original formats: date, time, senderOrSystem, message
      // Indices 0-2: Hyphen format with 4-digit or 2-digit year
      // Index 3: Bracket format with 2-digit year
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

    // WhatsApp media attachments can appear in various formats:
    // - "filename.ext (file attached)"
    // - "filename.ext (附件檔案)"
    // - "filename.ext"
    // - "<attached: filename.ext>"
    // - "<附件：filename.ext>" (Chinese format with fullwidth colon)
    // - "IMG-20240101-WA0001.jpg (file attached)"
    const mediaPatterns = [
      /([A-Za-z0-9_ \-\.]+\.(?:jpg|jpeg|png|gif|webp|mp4|mov|avi|mkv|webm|mp3|m4a|wav|ogg|opus|pdf|doc|docx|xls|xlsx|ppt|pptx))\s*(?:\(附件檔案\)|\(file attached\)|\(attached\))?\s*$/i,
      /(?:<attached:\s*|⟨attached:\s*)([A-Za-z0-9_ \-\.]+\.[A-Za-z0-9_ .-]+)(?:>|⟩)/i,
      /(?:<附件[：:]\s*|<Attachment[：:]\s*)([A-Za-z0-9_ \-\.]+\.[A-Za-z0-9_ .-]+)(?:>|⟩)/i,
      /(?:attached:\s*)([A-Za-z0-9_ \-\.]+\.[A-Za-z0-9_ .-]+)/i,
      /(?:附件[：:]\s*)([A-Za-z0-9_ \-\.]+\.[A-Za-z0-9_ .-]+)/i,
    ];

    for (const pattern of mediaPatterns) {
      const match = text.match(pattern);
      if (match) {
        mediaFilename = match[1];
        mediaType = getMediaType(mediaFilename);
        // Remove the filename and attachment indicator from the message
        cleanMessage = text.replace(pattern, '').trim() || '<Media omitted>';
        usedMediaFiles.add(mediaFilename);
        break;
      }
    }

    // If no media found in text but text looks like a media message, try to find a matching file
    if (!mediaFilename && availableMediaFiles.length > 0) {
      // Check for media indicators in Chinese and English
      const mediaIndicators: { text: string[]; type: MediaType }[] = [
        { text: ['照片', '图片', 'image', 'photo', 'picture', '📷'], type: 'image' },
        { text: ['视频', 'video', '🎥'], type: 'video' },
        { text: ['音频', '语音', 'audio', 'voice', '🎵'], type: 'audio' },
        { text: ['文件', 'document', 'file', '📎'], type: 'document' },
      ];

      const lowerText = text.toLowerCase();
      for (const indicator of mediaIndicators) {
        if (indicator.text.some(indicatorText => lowerText.includes(indicatorText))) {
          // Try to find an unused file matching the expected type
          for (const file of mediaFilesByType[indicator.type]) {
            if (!usedMediaFiles.has(file)) {
              mediaFilename = file;
              mediaType = getMediaType(file);
              cleanMessage = '<Media omitted>';
              usedMediaFiles.add(file);
              break;
            }
          }
          if (!mediaFilename && indicator.type !== 'document') {
            // Fallback: try any unused file if no type match found
            for (const file of mediaFilesByType.unknown) {
              if (!usedMediaFiles.has(file)) {
                mediaFilename = file;
                mediaType = getMediaType(file);
                cleanMessage = '<Media omitted>';
                usedMediaFiles.add(file);
                break;
              }
            }
          }
          if (mediaFilename) break;
        }
      }
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
      datetime: parseDateTime(date, time),
    });
  }

  return messages;
}

// Parse a standalone txt file
export function parseTextFile(textFilePath: string, chatId: string, mediaFiles: string[] = []): Message[] {
  const textContent = readFileSync(textFilePath, 'utf-8');
  return parseWhatsAppText(textContent, chatId, mediaFiles);
}

// Open a zip file using yauzl (streaming, supports files > 2 GiB)
function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    logger.debug({ zipPath }, 'Opening zip file');
    yauzl.open(zipPath, { lazyEntries: false }, (err, zipfile) => {
      if (err) {
        logger.error({ error: err, zipPath }, 'Failed to open zip');
        reject(err);
      } else {
        logger.debug({ zipPath, entryCount: zipfile?.entryCount }, 'Zip opened successfully');
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

  logger.debug({ filename, zipPath, tempDir, extractDir }, 'Extracting and parsing zip');

  if (existsSync(extractDir)) {
    logger.debug({ extractDir }, 'Cleaning existing extraction dir');
    rmSync(extractDir, { recursive: true, force: true });
  }
  mkdirSync(extractDir, { recursive: true });

  logger.debug({ filename }, 'Opening zip file');
  const zipfile = await openZip(zipPath);
  logger.debug({ entryCount: zipfile.entryCount }, 'Reading zip entries');

  return new Promise((resolve, reject) => {
    let txtFile = '';
    let txtContent = '';
    const mediaFiles: string[] = [];
    let pendingReads = 0;
    let entryCount = 0;
    let finished = false;

    const finish = () => {
      if (finished) {
        logger.debug({ filename }, 'Finish called multiple times, skipping');
        return;
      }
      finished = true;
      logger.debug({ filename, txtFile, txtContentLength: txtContent.length, mediaFileCount: mediaFiles.length }, 'Finish called');

      if (!txtFile) {
        logger.error({ filename, entryCount }, 'No txt file found in zip');
        reject(new Error(`No .txt file found in zip archive: ${filename}`));
        return;
      }

      logger.debug({ filename, txtContentLength: txtContent.length }, 'Parsing text content');
      const messages = parseWhatsAppText(txtContent, chatId, mediaFiles);
      logger.debug({ filename, messageCount: messages.length }, 'Parsed messages');

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

      logger.trace({ filename, entryCount, entryName, entryFileName: entry.fileName }, 'Processing zip entry');

      if (/\/$/.test(entry.fileName) || entryName.startsWith('.')) {
        logger.trace({ filename, entryName }, 'Skipping entry (directory or hidden)');
        return;
      }

      if (entryName.endsWith('.txt')) {
        txtFile = entryName;
        logger.debug({ filename, entryName }, 'Reading txt file');
        pendingReads++;
        readEntryToString(zipfile, entry)
          .then(content => {
            txtContent = content;
            logger.debug({ filename, entryName, contentLength: content.length }, 'Read txt file');
            pendingReads--;
            if (pendingReads === 0) finish();
          })
          .catch(err => {
            logger.error({ error: err, filename, entryName }, 'Error reading txt');
            pendingReads--;
            if (pendingReads === 0) finish();
          });
      } else {
        mediaFiles.push(entryName);
        logger.trace({ filename, entryName }, 'Tracking as media file');
      }
    });

    zipfile.on('end', () => {
      logger.debug({ filename, entryCount, pendingReads }, 'Zip entry end event');
      if (pendingReads === 0 && !finished) finish();
    });

    zipfile.on('error', (err: Error) => {
      if (!finished) {
        logger.error({ error: err, filename, stack: err.stack }, 'Zip error');
        reject(new Error(`Zip error for ${filename}: ${err.message}`));
      }
    });

    setTimeout(() => {
      if (!finished) {
        logger.error({ filename, entryCount, pendingReads }, 'Zip parsing timeout after 30s');
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

  logger.debug({ targetFilename, zipPath, destPath }, 'Extracting file from zip');
  const zipfile = await openZip(zipPath);

  return new Promise((resolve, reject) => {
    let found = false;

    zipfile.on('entry', (entry: yauzl.Entry) => {
      const entryName = basename(entry.fileName);
      logger.trace({ targetFilename, entryName }, 'Checking zip entry');

      if (entryName === targetFilename) {
        found = true;
        extractEntry(zipfile, entry, destPath)
          .then(() => resolve(destPath))
          .catch(err => reject(err));
      }
    });

    zipfile.on('end', () => {
      if (!found) {
        logger.error({ targetFilename, filename }, 'File not found in zip');
        reject(new Error(`File "${targetFilename}" not found in zip: ${filename}`));
      }
    });

    zipfile.on('error', (err: Error) => {
      logger.error({ error: err, targetFilename, filename }, 'Zip error extracting file');
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
