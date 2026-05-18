import { extractAndParseZip, parseTextFile } from './parser.js';
import { join, basename, dirname } from 'path';
import { WhatsAppDatabase } from './database.js';
import { readdirSync, statSync, rmSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import logger from './logger.js';

// Generate display name from filename
function getDisplayName(filename: string): string {
  // Remove .zip extension and common prefixes
  let name = filename.replace(/\.zip$/i, '');

  // Try to extract a readable name from common patterns
  // E.g., "WhatsApp Chat with John Doe.txt" -> "John Doe"
  const withMatch = name.match(/with\s+(.+)$/i);
  if (withMatch) {
    return withMatch[1].trim();
  }

  return name;
}

// Generate last message preview (truncate and clean)
function getPreview(text: string, maxLength: number = 50): string {
  if (!text) return '';
  let preview = text.replace(/\n/g, ' ').trim();
  if (preview.length > maxLength) {
    preview = preview.substring(0, maxLength) + '...';
  }
  return preview;
}

// Create a safe chat ID from filename (for database keys)
export function createChatId(filename: string): string {
  // Remove .zip extension
  const baseName = filename.replace(/\.zip$/i, '');
  // Hash = filename if it contains non-ASCII characters to create a safe ID
  // Use MD5 hash of filename for safe database key
  const hash = createHash('md5').update(baseName).digest('hex');
  return `chat_${hash}`;
}

// Index all txt files found inside a zip
async function indexTxtFiles(txtFiles: string[], zipPath: string, extractDir: string, db: WhatsAppDatabase, tempDir: string): Promise<void> {
  for (const txtFile of txtFiles) {
    const txtFilePath = join(extractDir, txtFile);
    const chatId = createChatId(txtFile);
    const messages = parseTextFile(txtFilePath, chatId);

    if (messages.length === 0) {
      logger.debug({ txtFile }, 'No messages found');
      continue;
    }

    const firstMsg = messages[0];
    const lastMsg = messages[messages.length - 1];

    const chat = {
      id: chatId,
      filename: txtFile,
      originalPath: zipPath,
      displayName: getDisplayName(txtFile),
      messageCount: messages.length,
      firstMessageDate: firstMsg.date,
      lastMessageDate: lastMsg.date,
      lastMessagePreview: getPreview(lastMsg.text),
      isZip: false,
    };

    db.upsertChat(chat);
    db.insertMessages(messages);

    logger.info({ txtFile, messageCount: messages.length }, 'Indexed messages');
  }
}

// Index a single zip file
export async function indexZip(zipPath: string, db: WhatsAppDatabase, tempDir: string): Promise<void> {
  const filename = basename(zipPath);
  const isZip = zipPath.endsWith('.zip');

  logger.debug({ filename, isZip, tempDir }, 'Starting to index');

  if (isZip) {
    try {
      logger.debug({ filename }, 'Calling extractAndParseZip');
      const { chatId, extractDir, txtFile, messages, mediaFiles } = await extractAndParseZip(zipPath, tempDir);
      logger.debug({ filename, chatId, txtFile, messageCount: messages.length, mediaFileCount: mediaFiles.length }, 'Extracted');

      if (messages.length === 0) {
        logger.info({ txtFile }, 'No messages found');
        return;
      }

      const firstMsg = messages[0];
      const lastMsg = messages[messages.length - 1];

      const chat = {
        id: chatId,
        filename: filename,
        originalPath: zipPath,
        displayName: getDisplayName(filename),
        messageCount: messages.length,
        firstMessageDate: firstMsg.date,
        lastMessageDate: lastMsg.date,
        lastMessagePreview: getPreview(lastMsg.text),
        isZip: true,
      };

      logger.debug({ chatId }, 'Upserting chat');
      db.upsertChat(chat);
      logger.debug({ chatId, messageCount: messages.length }, 'Deleting old messages and inserting new');
      db.deleteMessages(chatId);
      db.insertMessages(messages);
      logger.debug({ chatId }, 'Messages inserted successfully');
      logger.info({ txtFile, messageCount: messages.length, mediaFileCount: mediaFiles.length }, 'Indexed zip file');
    } catch (error) {
      logger.error(
        { error, filename, message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : 'No stack' },
        'Error indexing zip'
      );
      throw error;
    }
  } else {
    // Handle standalone txt file (not in zip)
    const chatId = createChatId(filename);
    const messages = parseTextFile(zipPath, chatId);

    if (messages.length === 0) {
      logger.info({ filename }, 'No messages found');
      return;
    }

    const firstMsg = messages[0];
    const lastMsg = messages[messages.length - 1];

    const chat = {
      id: chatId,
      filename,
      originalPath: zipPath,
      displayName: getDisplayName(filename),
      messageCount: messages.length,
      firstMessageDate: firstMsg.date,
      lastMessageDate: lastMsg.date,
      lastMessagePreview: getPreview(lastMsg.text),
      isZip: false,
    };

    db.upsertChat(chat);
    db.insertMessages(messages);
    logger.info({ filename, messageCount: messages.length }, 'Indexed txt file');
  }
  logger.debug({ filename }, 'Finished indexing');
}

// Re-index all zip and txt files in a directory
export async function reindexAll(directory: string, db: WhatsAppDatabase, tempDir: string): Promise<void> {
  const files = readdirSync(directory).filter(f => f.endsWith('.zip') || f.endsWith('.txt'));

  logger.info({ directory, fileCount: files.length }, 'Starting reindex of all files');

  for (const file of files) {
    const filePath = join(directory, file);
    if (statSync(filePath).isFile()) {
      await indexZip(filePath, db, tempDir);
    }
  }

  logger.info('Reindexing complete');
}

// Re-index a specific chat
export async function reindexChat(chatId: string, db: WhatsAppDatabase, tempDir: string): Promise<void> {
  const chat = db.getChat(chatId);
  if (!chat) {
    throw new Error(`Chat ${chatId} not found`);
  }

  logger.info({ chatId, filename: chat.filename }, 'Re-indexing chat');

  db.deleteMessages(chatId);

  await indexZip(chat.originalPath || '', db, tempDir);
}