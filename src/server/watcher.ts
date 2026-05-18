import { watch, FSWatcher } from 'chokidar';
import { join, basename } from 'path';
import { indexZip, reindexChat, createChatId } from './indexer.js';
import { WhatsAppDatabase } from './database.js';
import logger from './logger.js';

// Track in-flight operations to avoid duplicate processing
const processing = new Set<string>();

export function startWatcher(directory: string, db: WhatsAppDatabase, tempDir: string): FSWatcher {
  logger.info({ directory }, 'Starting file watcher');

  const watcher = watch(directory, {
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 100,
    },
  }) as FSWatcher;

  // Map filename to chatId for lookups
  const filenameToChatId = new Map<string, string>();

  // Watch for new zip or txt files
  watcher.on('add', async (filePath: string) => {
    if (!filePath.endsWith('.zip') && !filePath.endsWith('.txt')) return;

    const filename = basename(filePath);
    const chatId = createChatId(filename);
    filenameToChatId.set(filename, chatId);

    if (processing.has(chatId)) {
      logger.debug({ filename, chatId }, 'Skipping file: already processing');
      return;
    }

    processing.add(chatId);

    try {
      await indexZip(filePath, db, tempDir);
    } catch (error) {
      logger.error({ error, filename, chatId }, 'Failed to index file');
    } finally {
      processing.delete(chatId);
    }
  });

  // Watch for file updates (only re-index zip files, not txt)
  watcher.on('change', async (filePath: string) => {
    if (!filePath.endsWith('.zip')) return;

    const filename = basename(filePath);
    const chatId = createChatId(filename);
    filenameToChatId.set(filename, chatId);

    if (processing.has(chatId)) return;

    processing.add(chatId);

    try {
      logger.info({ filename, chatId }, 'Zip file changed, re-indexing');
      await reindexChat(chatId, db, tempDir);
    } catch (error) {
      logger.error({ error, filename, chatId }, 'Failed to re-index file');
    } finally {
      processing.delete(chatId);
    }
  });

  // Watch for deleted zip or txt files
  watcher.on('unlink', async (filePath: string) => {
    if (!filePath.endsWith('.zip') && !filePath.endsWith('.txt')) return;

    const filename = basename(filePath);
    const chatId = filenameToChatId.get(filename);

    logger.info({ filename, chatId: chatId || 'unknown' }, 'File deleted');

    if (!chatId) {
      logger.warn({ filename }, 'No chat ID found, skipping database delete');
      filenameToChatId.delete(filename);
      return;
    }

    try {
      db.deleteChat(chatId);
      logger.info({ chatId, filename }, 'Removed chat from database');
      filenameToChatId.delete(filename);
    } catch (error) {
      logger.error({ error, chatId, filename }, 'Failed to delete chat');
    }
  });

  return watcher;
}