import { watch, FSWatcher } from 'chokidar';
import { join, basename } from 'path';
import { indexZip, reindexChat } from './indexer.js';
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

  // Watch for new zip files
  watcher.on('add', async (filePath: string) => {
    if (!filePath.endsWith('.zip')) return;

    const filename = basename(filePath);
    const chatId = filename.replace(/\.zip$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_');

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
    const chatId = filename.replace(/\.zip$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_');

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
    const chatId = filename.replace(/\.zip$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_');

    console.log(`Zip file deleted: ${filename}`);

    try {
      db.deleteChat(chatId);
      console.log(`Removed chat ${chatId} from database`);
    } catch (error) {
      console.error(`Failed to delete chat ${chatId}:`, error);
    }
  });

  return watcher;
}