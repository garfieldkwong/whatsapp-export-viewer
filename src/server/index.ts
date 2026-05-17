import express, { Request, Response } from 'express';
import { CONFIG } from './config.js';
import { WhatsAppDatabase, Chat } from './database.js';
import { startWatcher } from './watcher.js';
import { reindexAll, reindexChat } from './indexer.js';
import { extractAndParseZip, cleanupExtraction, cleanupAllTemp } from './parser.js';
import { mkdirSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import path from 'path';
import http from 'http';
import https from 'https';

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
    console.log(`[MEDIA] Request: chatId=${chatId}, filename=${filename}`);

    if (!filename) {
      return res.status(400).json({ error: 'Filename is required' });
    }

    const chat = db.getChat(chatId);
    console.log(`[MEDIA] Chat found:`, chat ? 'yes' : 'no');

    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    const chatWithOriginalPath = chat as Chat & { originalPath: string };
    console.log(`[MEDIA] originalPath:`, chatWithOriginalPath.originalPath);

    // Extract file from zip on-demand
    const { extractFileFromZip } = await import('./parser.js');
    const mediaPath = await extractFileFromZip(chatWithOriginalPath.originalPath, filename, tempDir);
    console.log(`[MEDIA] Extracted to: ${mediaPath}`);

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
  const mb = (v: number) => Math.round(v / 1024 / 1024);
  console.log(`[MEMORY] ${label}: RSS=${mb(usage.rss)}MB heap=${mb(usage.heapUsed)}/${mb(usage.heapTotal)}MB external=${mb(usage.external)}MB`);
}

// Start server
async function start(): Promise<void> {
  // Clean temp directory on startup
  console.log('Cleaning temp directory...');
  cleanupAllTemp(tempDir);

  // Force garbage collection if available (node --gc)
  if (global.gc) {
    global.gc();
  }

  logMemory('After startup cleanup');

  // Index existing files if configured
  if (CONFIG.REINDEX_ON_STARTUP) {
    console.log('Reindexing existing files...');
    try {
      await reindexAll(watchDir, db, tempDir);
      if (global.gc) global.gc();
      logMemory('After reindex');
    } catch (error) {
      console.error('Error during reindex:', error);
      console.error('Error stack:', error instanceof Error ? error.stack : 'No stack');
    }
  } else {
    console.log('Skipping reindex on startup (set REINDEX_ON_STARTUP=true to enable)');
  }

  // Start file watcher
  startWatcher(watchDir, db, tempDir);

  const useSSL = CONFIG.SSL_CERT_PATH && CONFIG.SSL_KEY_PATH;

  if (useSSL) {
    const certPath = CONFIG.SSL_CERT_PATH;
    const keyPath = CONFIG.SSL_KEY_PATH;

    if (!existsSync(certPath)) {
      console.error(`SSL certificate not found at: ${certPath}`);
      process.exit(1);
    }
    if (!existsSync(keyPath)) {
      console.error(`SSL key not found at: ${keyPath}`);
      process.exit(1);
    }

    const sslOptions = {
      cert: readFileSync(certPath),
      key: readFileSync(keyPath),
    };

    https.createServer(sslOptions, app).listen(CONFIG.PORT, () => {
      console.log(`\n🚀 WhatsApp Export Viewer running at https://localhost:${CONFIG.PORT}`);
      console.log(`🔒 SSL enabled (cert: ${certPath})`);
      console.log(`📁 Watching: ${watchDir}`);
      console.log(`💡 Place your WhatsApp .zip exports in: ${watchDir}\n`);
    });
  } else {
    http.createServer(app).listen(CONFIG.PORT, () => {
      console.log(`\n🚀 WhatsApp Export Viewer running at http://localhost:${CONFIG.PORT}`);
      console.log(`📁 Watching: ${watchDir}`);
      console.log(`💡 Place your WhatsApp .zip exports in: ${watchDir}\n`);
    });
  }
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