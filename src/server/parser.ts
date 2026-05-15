import AdmZip from 'adm-zip';
import { readdirSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { Message } from './database.js';

export type MediaType = 'image' | 'video' | 'audio' | 'document' | 'unknown';

export interface ExtractionResult {
  chatId: string;
  extractDir: string;
  txtFile: string;
  messages: Message[];
  mediaFiles: string[];
}

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
  '.txt': 'document',
};

function getMediaType(filename: string): MediaType {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  return MEDIA_TYPES[ext] || 'unknown';
}

// Clean hidden Unicode characters from text
function cleanText(text: string): string {
  // Remove LRM, RLM, and other directional marks
  return text.replace(/[‎‏‪-‮⁦-⁩]/g, '').trim();
}

// Parse WhatsApp export text format (from txt file)
export function parseTextFile(textFilePath: string, chatId: string): Message[] {
  const textContent = readFileSync(textFilePath, 'utf-8');
  return parseWhatsAppText(textContent, chatId);
}

// Parse WhatsApp export text format
// Sample lines:
// 5/7/2022 6:56:06 pm - ~SnoopyJesse新增了你
// 6/14/2022 12:05:43 pm - SnoopyJesse: <Media omitted>
// 6/14/2022 12:05:43 pm - SnoopyJesse: <Media omitted> (附件檔案)
function parseWhatsAppText(textContent: string, chatId: string): Message[] {
  const lines = textContent.split(/\r?\n/);
  const messages: Message[] = [];
  let position = 0;

  // Regex to capture WhatsApp message format
  // Matches: DATE TIME - SENDER: MESSAGE
  // Also handles system messages (no colon)
  const messageRegex = /^(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]m)?)\s+-\s+(.*?)(?::\s*(.*))?$/;

  for (const line of lines) {
    const cleanedLine = cleanText(line);
    if (!cleanedLine) continue;

    const match = cleanedLine.match(messageRegex);
    if (!match) continue;

    const [, date, time, senderOrSystem, message] = match;

    // Determine if this is a system message or user message
    const isSystemMessage = message === undefined;
    const sender = isSystemMessage ? null : senderOrSystem;
    const text = isSystemMessage ? senderOrSystem : (message || '');

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

// Extract zip file and parse contents
export function extractAndParseZip(zipPath: string, tempDir: string): ExtractionResult {
  const chatId = zipPath.split('/').pop()?.replace(/\.zip$/i, '') || '';
  const extractDir = join(tempDir, chatId);

  try {
    // Clean up existing extraction if present
    if (existsSync(extractDir)) {
      rmSync(extractDir, { recursive: true, force: true });
    }
    mkdirSync(extractDir, { recursive: true });

    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractDir, true);

    // Find the .txt file (usually the chat history)
    // WhatsApp exports typically use "_chat.txt" as the filename
    const files = readdirSync(extractDir);
    const txtFile = files.find(f => f.endsWith('.txt'));

    if (!txtFile) {
      throw new Error('No .txt file found in zip archive');
    }

    const textContent = readFileSync(join(extractDir, txtFile), 'utf-8');

    return {
      chatId,
      extractDir,
      txtFile,
      messages: parseWhatsAppText(textContent, chatId),
      mediaFiles: files.filter(f => f !== txtFile),
    };
  } catch (error) {
    // Clean up on error
    if (existsSync(extractDir)) {
      rmSync(extractDir, { recursive: true, force: true });
    }
    throw error;
  }
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