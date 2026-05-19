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

interface ParsedMessageHeader {
  date: string;
  time: string;
  sender: string | null;
  text: string;
  isSystemMessage: boolean;
}

interface FormatRule {
  regex: RegExp;
  extract: (match: RegExpMatchArray) => ParsedMessageHeader;
}

const FORMAT_RULES: FormatRule[] = [
  {
    // Hyphen format: M/D/YYYY 6:56:06 pm - Sender: Message
    // Also covers 2-digit year variants with/without comma and am/pm
    regex: /^(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]m)?)\s+-\s+([^:]+):\s*(.*)$/i,
    extract: (m) => {
      const sender = m[3]?.trim() || null;
      return { date: m[1], time: m[2], sender, text: m[4] || '', isSystemMessage: !sender };
    },
  },
  {
    // English bracket format: [12/25/22, 10:00:00 AM] Sender: Message
    regex: /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?\s*[ap]m)\]\s+([^:]+):\s*(.*)$/i,
    extract: (m) => {
      const sender = m[3]?.trim() || null;
      return { date: m[1], time: m[2], sender, text: m[4] || '', isSystemMessage: !sender };
    },
  },
  {
    // Chinese bracket format with sender: [9/8/2024 下午11:02:13] Sender: Message
    regex: /^\[(\d{1,2}\/\d{1,2}\/\d{4}),?\s+(上午|下午|am|pm)\s*(\d{1,2}:\d{2}:\d{2})\]\s+([^:]+):\s*(.*)$/i,
    extract: (m) => ({
      date: m[1], time: `${m[2]}${m[3]}`, sender: m[4]?.trim() || null, text: m[5] || '', isSystemMessage: false,
    }),
  },
  {
    // Chinese bracket format system message: [9/8/2024 下午11:02:13] Message
    regex: /^\[(\d{1,2}\/\d{1,2}\/\d{4}),?\s+(上午|下午|am|pm)\s*(\d{1,2}:\d{2}:\d{2})\]\s+(.+)$/i,
    extract: (m) => ({
      date: m[1], time: `${m[2]}${m[3]}`, sender: null, text: m[4], isSystemMessage: true,
    }),
  },
];

const MEDIA_PATTERNS = [
  /([A-Za-z0-9_ \-\.]+\.(?:jpg|jpeg|png|gif|webp|mp4|mov|avi|mkv|webm|mp3|m4a|wav|ogg|opus|pdf|doc|docx|xls|xlsx|ppt|pptx))\s*(?:\(附件檔案\)|\(file attached\)|\(attached\))?\s*$/i,
  /(?:<attached:\s*|⟨attached:\s*)([A-Za-z0-9_ \-\.]+\.[A-Za-z0-9_ .-]+)(?:>|⟩)/i,
  /(?:<附件[：:]\s*|<Attachment[：:]\s*)([A-Za-z0-9_ \-\.]+\.[A-Za-z0-9_ .-]+)(?:>|⟩)/i,
  /(?:attached:\s*)([A-Za-z0-9_ \-\.]+\.[A-Za-z0-9_ .-]+)/i,
  /(?:附件[：:]\s*)([A-Za-z0-9_ \-\.]+\.[A-Za-z0-9_ .-]+)/i,
];

const MEDIA_INDICATORS: { keywords: string[]; type: MediaType }[] = [
  { keywords: ['照片', '图片', 'image', 'photo', 'picture', '📷'], type: 'image' },
  { keywords: ['视频', 'video', '🎥'], type: 'video' },
  { keywords: ['音频', '语音', 'audio', 'voice', '🎵'], type: 'audio' },
  { keywords: ['文件', 'document', 'file', '📎'], type: 'document' },
];

const MEDIA_OMITTED_RE = /(圖片|视频|音频|文件)已略去$/;

function findUnusedMediaFile(
  mediaFilesByType: Record<MediaType, string[]>,
  usedMediaFiles: Set<string>,
  preferredType: MediaType,
  allowFallback: boolean,
): { filename: string; type: MediaType } | null {
  for (const file of mediaFilesByType[preferredType]) {
    if (!usedMediaFiles.has(file)) {
      return { filename: file, type: getMediaType(file) };
    }
  }
  if (allowFallback) {
    for (const file of mediaFilesByType.unknown) {
      if (!usedMediaFiles.has(file)) {
        return { filename: file, type: getMediaType(file) };
      }
    }
  }
  return null;
}

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

    let header: ParsedMessageHeader | null = null;

    for (const rule of FORMAT_RULES) {
      const match = cleanedLine.match(rule.regex);
      if (match) {
        header = rule.extract(match);
        break;
      }
    }

    if (!header) {
      if (messages.length > 0) {
        messages[messages.length - 1].text += '\n' + cleanedLine;
      }
      continue;
    }

    const { date, time, sender, text, isSystemMessage } = header;

    let mediaFilename: string | null = null;
    let mediaType: MediaType | null = null;
    let cleanMessage = text;

    for (const pattern of MEDIA_PATTERNS) {
      const patternMatch = text.match(pattern);
      if (patternMatch) {
        mediaFilename = patternMatch[1];
        mediaType = getMediaType(mediaFilename);
        cleanMessage = text.replace(pattern, '').trim() || '<Media omitted>';
        usedMediaFiles.add(mediaFilename);
        break;
      }
    }

    if (!mediaFilename && availableMediaFiles.length > 0) {
      const lowerText = text.toLowerCase();
      for (const indicator of MEDIA_INDICATORS) {
        if (!indicator.keywords.some(kw => lowerText.includes(kw))) continue;
        const result = findUnusedMediaFile(mediaFilesByType, usedMediaFiles, indicator.type, indicator.type !== 'document');
        if (result) {
          mediaFilename = result.filename;
          mediaType = result.type;
          cleanMessage = '<Media omitted>';
          usedMediaFiles.add(result.filename);
          break;
        }
      }
    }

    cleanMessage = cleanMessage.replace(MEDIA_OMITTED_RE, '<Media omitted>');

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
export async function extractAndParseZip(zipPath: string, tempDir: string, chatIdOverride?: string): Promise<ExtractionResult> {
  const filename = basename(zipPath);
  const baseName = filename.replace(/\.zip$/i, '');
  const chatId = chatIdOverride || baseName;
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
