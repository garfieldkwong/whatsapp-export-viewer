import { watch, FSWatcher } from 'chokidar';
import { join, basename } from 'path';
import { indexZip, reindexChat, createChatId } from './indexer.js';
import { WhatsAppDatabase } from './database.js';
import logger from './logger.js';

const processing = new Set<string>();

export function startWatcher(directory: string, db: WhatsAppDatabase, tempDir: string): FSWatcher {
  logger.info({ directory }, 'Starting file watcher');

  const watcher = watch(directory, {
    ignored: /(^|[\/\\])\../,
    persistent: true,
    depth: 10,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 100,
    },
  }) as FSWatcher;

  const filePathToChatId = new Map<string, string>();

  watcher.on('add', async (filePath: string) => {
    if (!filePath.endsWith('.zip') && !filePath.endsWith('.txt')) return;

    const chatId = createChatId(filePath, directory);
    filePathToChatId.set(filePath, chatId);

    if (processing.has(chatId)) {
      logger.debug({ filePath, chatId }, 'Skipping file: already processing');
      return;
    }

    processing.add(chatId);

    try {
      await indexZip(filePath, db, tempDir, directory);
    } catch (error) {
      logger.error({ error, filePath, chatId }, 'Failed to index file');
    } finally {
      processing.delete(chatId);
    }
  });

  watcher.on('change', async (filePath: string) => {
    if (!filePath.endsWith('.zip')) return;

    const chatId = createChatId(filePath, directory);
    filePathToChatId.set(filePath, chatId);

    if (processing.has(chatId)) return;

    processing.add(chatId);

    try {
      logger.info({ filePath, chatId }, 'Zip file changed, re-indexing');
      await reindexChat(chatId, db, tempDir, directory);
    } catch (error) {
      logger.error({ error, filePath, chatId }, 'Failed to re-index file');
    } finally {
      processing.delete(chatId);
    }
  });

  watcher.on('unlink', async (filePath: string) => {
    if (!filePath.endsWith('.zip') && !filePath.endsWith('.txt')) return;

    const chatId = filePathToChatId.get(filePath);

    logger.info({ filePath, chatId: chatId || 'unknown' }, 'File deleted');

    if (!chatId) {
      logger.warn({ filePath }, 'No chat ID found, skipping database delete');
      filePathToChatId.delete(filePath);
      return;
    }

    try {
      db.deleteChat(chatId);
      logger.info({ chatId, filePath }, 'Removed chat from database');
      filePathToChatId.delete(filePath);
    } catch (error) {
      logger.error({ error, chatId, filePath }, 'Failed to delete chat');
    }
  });

  return watcher;
}
