import { extractAndParseZip, parseTextFile } from './parser.js';
import { join, basename, dirname, relative } from 'path';
import { WhatsAppDatabase } from './database.js';
import { readdirSync, statSync, rmSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import logger from './logger.js';

function getDisplayName(filename: string): string {
  let name = filename.replace(/\.zip$/i, '');

  const withMatch = name.match(/with\s+(.+)$/i);
  if (withMatch) {
    return withMatch[1].trim();
  }

  return name;
}

function getPreview(text: string, maxLength: number = 50): string {
  if (!text) return '';
  let preview = text.replace(/\n/g, ' ').trim();
  if (preview.length > maxLength) {
    preview = preview.substring(0, maxLength) + '...';
  }
  return preview;
}

export function createChatId(filePath: string, watchDir: string): string {
  const relPath = relative(watchDir, filePath).replace(/\\/g, '/');
  const hash = createHash('md5').update(relPath).digest('hex');
  return `chat_${hash}`;
}

function getFolderFromPath(filePath: string, watchDir: string): string {
  const rel = relative(watchDir, filePath).replace(/\\/g, '/');
  const parts = rel.split('/');
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join('/');
}

async function indexTxtFiles(txtFiles: string[], zipPath: string, extractDir: string, db: WhatsAppDatabase, tempDir: string, watchDir: string, folder: string): Promise<void> {
  for (const txtFile of txtFiles) {
    const txtFilePath = join(extractDir, txtFile);
    const chatId = createChatId(txtFile, watchDir);
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
      folder,
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

export async function indexZip(zipPath: string, db: WhatsAppDatabase, tempDir: string, watchDir: string): Promise<void> {
  const filename = basename(zipPath);
  const isZip = zipPath.endsWith('.zip');
  const folder = getFolderFromPath(zipPath, watchDir);
  const chatId = createChatId(zipPath, watchDir);

  logger.debug({ filename, isZip, tempDir, folder }, 'Starting to index');

  if (isZip) {
    try {
      logger.debug({ filename }, 'Calling extractAndParseZip');
      const { extractDir, txtFile, messages, mediaFiles } = await extractAndParseZip(zipPath, tempDir, chatId);
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
        folder,
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
      folder,
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

function collectFilesRecursive(directory: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFilesRecursive(fullPath));
    } else if (entry.isFile() && (entry.name.endsWith('.zip') || entry.name.endsWith('.txt'))) {
      results.push(fullPath);
    }
  }
  return results;
}

export async function reindexAll(directory: string, db: WhatsAppDatabase, tempDir: string): Promise<void> {
  const files = collectFilesRecursive(directory);

  logger.info({ directory, fileCount: files.length }, 'Starting reindex of all files');

  for (const filePath of files) {
    if (statSync(filePath).isFile()) {
      await indexZip(filePath, db, tempDir, directory);
    }
  }

  logger.info('Reindexing complete');
}

export async function reindexChat(chatId: string, db: WhatsAppDatabase, tempDir: string, watchDir: string): Promise<void> {
  const chat = db.getChat(chatId);
  if (!chat) {
    throw new Error(`Chat ${chatId} not found`);
  }

  logger.info({ chatId, filename: chat.filename }, 'Re-indexing chat');

  db.deleteMessages(chatId);

  await indexZip(chat.originalPath || '', db, tempDir, watchDir);
}