import express, { Request, Response } from 'express';
import { CONFIG } from './config.js';
import { WhatsAppDatabase, Chat } from './database.js';
import { startWatcher } from './watcher.js';
import { reindexAll, reindexChat } from './indexer.js';
import { extractAndParseZip, cleanupExtraction, cleanupAllTemp } from './parser.js';
import { mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve paths - use absolute paths directly from config
const watchDir = CONFIG.WATCH_DIR.startsWith('/') ? CONFIG.WATCH_DIR : join(__dirname, '../', CONFIG.WATCH_DIR);
const tempDir = CONFIG.TEMP_DIR.startsWith('/') ? CONFIG.TEMP_DIR : join(__dirname, '../', CONFIG.TEMP_DIR);
mkdirSync(watchDir, { recursive: true });
mkdirSync(tempDir, { recursive: true });

// Initialize database
const db = new WhatsAppDatabase();

// Track active extractions for cleanup
const activeExtractions = new Map<string, string>();

// Create Express app
const app = express();
app.use(express.json());

// Serve static files from public directory
app.use(express.static(join(process.cwd(), 'dist/public')));

// Health check
app.get('/api/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Get all chats
app.get('/api/chats', (req: Request, res: Response) => {
  try {
    const chats = db.getAllChats();
    res.json(chats);
  } catch (error) {
    console.error('Error fetching chats:', error);
    res.status(500).json({ error: 'Failed to fetch chats' });
  }
});

// Get single chat details
app.get('/api/chats/:id', (req: Request, res: Response) => {
  try {
    const chat = db.getChat(req.params.id as string);
    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }
    res.json(chat);
  } catch (error) {
    console.error('Error fetching chat:', error);
    res.status(500).json({ error: 'Failed to fetch chat' });
  }
});

// Get messages with pagination
app.get('/api/chats/:id/messages', (req: Request, res: Response) => {
  try {
    const chatId = req.params.id as string;
    const offset = parseInt((req.query.offset as string | undefined) || '0');
    const limit = parseInt((req.query.limit as string | undefined) || String(CONFIG.DEFAULT_PAGE_SIZE));

    const messages = db.getMessages(chatId, offset, limit);
    const total = db.getMessageCount(chatId);

    res.json({
      messages,
      pagination: {
        offset,
        limit,
        total,
        hasMore: offset + limit < total,
      },
    });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Search messages
app.get('/api/search', (req: Request, res: Response) => {
  try {
    const query = (req.query.q as string | string[] | undefined)?.toString();
    const chatId = ((req.query.chatId as string | string[] | undefined)?.toString()) || null;

    if (!query) {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    const results = db.searchMessages(query, chatId);
    res.json({ query, results });
  } catch (error) {
    console.error('Error searching messages:', error);
    res.status(500).json({ error: 'Failed to search messages' });
  }
});

// Serve media files
app.get('/api/media/:chatId/:filename(*)', async (req: Request, res: Response) => {
  try {
    const { chatId, filename } = req.params as { chatId: string; filename: string };
    const chat = db.getChat(chatId) as Chat & { originalPath: string };

    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    let mediaPath: string;

    // Check if chat is already extracted
    if (activeExtractions.has(chatId)) {
      mediaPath = join(activeExtractions.get(chatId)!, filename);
    } else {
      // Extract temporarily
      const { extractDir } = await extractAndParseZip(chat.originalPath, tempDir);
      activeExtractions.set(chatId, extractDir);

      // Set up cleanup after inactivity (5 minutes)
      setTimeout(() => {
        cleanupExtraction(extractDir);
        activeExtractions.delete(chatId);
      }, 5 * 60 * 1000);

      mediaPath = join(extractDir, filename);
    }

    if (!existsSync(mediaPath)) {
      return res.status(404).json({ error: 'Media file not found' });
    }

    // Set appropriate content type based on file extension
    const ext = path.extname(filename).toLowerCase();
    const contentTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.webm': 'video/webm',
      '.mp3': 'audio/mpeg',
      '.m4a': 'audio/mp4',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
    };

    res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream');
    res.sendFile(mediaPath);
  } catch (error) {
    console.error('Error serving media:', error);
    res.status(500).json({ error: 'Failed to serve media' });
  }
});

// Trigger reindex of a chat
app.post('/api/chats/:id/reindex', async (req: Request, res: Response) => {
  try {
    await reindexChat(req.params.id as string, db, tempDir);
    res.json({ status: 'ok' });
  } catch (error) {
    console.error('Error reindexing chat:', error);
    res.status(500).json({ error: 'Failed to reindex chat' });
  }
});

// Trigger full reindex
app.post('/api/reindex', async (req: Request, res: Response) => {
  try {
    await reindexAll(watchDir, db, tempDir);
    res.json({ status: 'ok' });
  } catch (error) {
    console.error('Error reindexing:', error);
    res.status(500).json({ error: 'Failed to reindex' });
  }
});

// Log memory usage
function logMemory(label: string): void {
  const usage = process.memoryUsage();
  console.log(`[MEMORY] ${label}:`, {
    rss: `${Math.round(usage.rss / 1024 / 1024)}MB`,
    heapUsed: `${Math.round(usage.heapUsed / 1024 / 1024)}MB`,
    heapTotal: `${Math.round(usage.heapTotal / 1024 / 1024)}MB`,
    external: `${Math.round(usage.external / 1024 / 1024)}MB`,
  });
}

// Watch memory continuously during startup
function startMemoryWatch(intervalMs: number = 1000): NodeJS.Timeout {
  return setInterval(() => {
    const usage = process.memoryUsage();
    const mb = (v: number) => Math.round(v / 1024 / 1024);
    console.log(`[MEM WATCH] RSS:${mb(usage.rss)}MB heap:${mb(usage.heapUsed)}/${mb(usage.heapTotal)}MB external:${mb(usage.external)}MB`);
  }, intervalMs);
}

// Force output immediately
function flushLogs(): void {
  if (process.stdout.write) process.stdout.write?.('');
  if (process.stderr.write) process.stderr.write?.('');
}

// Start server
async function start(): Promise<void> {
  // Enable immediate output
  const memoryWatch = startMemoryWatch(2000);

  // Clean temp directory on startup
  console.log('Cleaning temp directory...');
  flushLogs();
  cleanupAllTemp(tempDir);

  // Force garbage collection if available (node --gc)
  if (global.gc) {
    global.gc();
  }

  logMemory('After startup cleanup');
  flushLogs();

  // Index existing files if configured
  if (CONFIG.REINDEX_ON_STARTUP) {
    console.log('Reindexing existing files...');
    flushLogs();
    try {
      await reindexAll(watchDir, db, tempDir);
      flushLogs();
      if (global.gc) global.gc();
      logMemory('After reindex');
      flushLogs();
    } catch (error) {
      console.error('Error during reindex:', error);
      console.error('Error stack:', error instanceof Error ? error.stack : 'No stack');
      flushLogs();
    }
  } else {
    console.log('Skipping reindex on startup (set REINDEX_ON_STARTUP=true to enable)');
    flushLogs();
  }

  // Stop memory watch
  clearInterval(memoryWatch);

  // Start file watcher
  startWatcher(watchDir, db, tempDir);

  // Start HTTP server
  app.listen(CONFIG.PORT, () => {
    console.log(`\n🚀 WhatsApp Export Viewer running at http://localhost:${CONFIG.PORT}`);
    console.log(`📁 Watching: ${watchDir}`);
    console.log(`💡 Place your WhatsApp .zip exports in: ${watchDir}\n`);
  });
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  db.close();
  cleanupAllTemp(tempDir);
  process.exit(0);
});

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});