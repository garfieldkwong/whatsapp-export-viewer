import { watch, FSWatcher } from 'chokidar';
import { join, basename } from 'path';
import { indexZip, reindexChat, createChatId } from './indexer.js';
import { WhatsAppDatabase } from './database.js';

// Track in-flight operations to avoid duplicate processing
const processing = new Set<string>();

export function startWatcher(directory: string, db: WhatsAppDatabase, tempDir: string): FSWatcher {
  console.log(`Starting file watcher on: ${directory}`);

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

  // Watch for new zip files
  watcher.on('add', async (filePath: string) => {
    if (!filePath.endsWith('.zip')) return;

    const filename = basename(filePath);
    const chatId = createChatId(filename);
    filenameToChatId.set(filename, chatId);

    if (processing.has(chatId)) {
      console.log(`Skipping ${filename}: already processing`);
      return;
    }

    processing.add(chatId);

    try {
      await indexZip(filePath, db, tempDir);
    } catch (error) {
      console.error(`Failed to index ${filename}:`, error);
    } finally {
      processing.delete(chatId);
    }
  });

  // Watch for file updates (replaced zip files)
  watcher.on('change', async (filePath: string) => {
    if (!filePath.endsWith('.zip')) return;

    const filename = basename(filePath);
    const chatId = createChatId(filename);
    filenameToChatId.set(filename, chatId);

    if (processing.has(chatId)) return;

    processing.add(chatId);

    try {
      console.log(`Zip file changed: ${filename}, re-indexing...`);
      await reindexChat(chatId, db, tempDir);
    } catch (error) {
      console.error(`Failed to re-index ${filename}:`, error);
    } finally {
      processing.delete(chatId);
    }
  });

  // Watch for deleted zip files
  watcher.on('unlink', async (filePath: string) => {
    if (!filePath.endsWith('.zip')) return;

    const filename = basename(filePath);
    const chatId = filenameToChatId.get(filename);

    console.log(`Zip file deleted: ${filename}`);

    if (!chatId) {
      console.warn(`No chat ID found for ${filename}, skipping database delete`);
      filenameToChatId.delete(filename);
      return;
    }

    try {
      db.deleteChat(chatId);
      console.log(`Removed chat ${chatId} from database`);
      filenameToChatId.delete(filename);
    } catch (error) {
      console.error(`Failed to delete chat ${chatId}:`, error);
    }
  });

  return watcher;
}