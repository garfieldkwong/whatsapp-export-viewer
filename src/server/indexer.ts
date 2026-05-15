import { extractAndParseZip } from './parser.js';
import { join, basename } from 'path';
import { WhatsAppDatabase } from './database.js';
import { readdirSync, statSync } from 'fs';

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

// Index a single zip file
export async function indexZip(zipPath: string, db: WhatsAppDatabase, tempDir: string): Promise<void> {
  const filename = basename(zipPath);
  const chatId = filename.replace(/\.zip$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_');

  console.log(`Indexing: ${filename}`);

  try {
    const { messages } = extractAndParseZip(zipPath, tempDir);

    if (messages.length === 0) {
      console.log(`  No messages found in ${filename}`);
      return;
    }

    // Prepare chat metadata
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
    };

    // Insert into database
    db.upsertChat(chat);
    db.insertMessages(messages);

    console.log(`  Indexed ${messages.length} messages for ${filename}`);
  } catch (error) {
    console.error(`  Error indexing ${filename}:`, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

// Re-index all zip files in a directory
export async function reindexAll(directory: string, db: WhatsAppDatabase, tempDir: string): Promise<void> {
  const files = readdirSync(directory).filter(f => f.endsWith('.zip'));

  console.log(`Found ${files.length} zip files to index`);

  for (const file of files) {
    const filePath = join(directory, file);
    if (statSync(filePath).isFile()) {
      await indexZip(filePath, db, tempDir);
    }
  }

  console.log('Indexing complete');
}

// Re-index a specific chat
export async function reindexChat(chatId: string, db: WhatsAppDatabase, tempDir: string): Promise<void> {
  const chat = db.getChat(chatId);
  if (!chat) {
    throw new Error(`Chat ${chatId} not found`);
  }

  console.log(`Re-indexing chat: ${chat.filename}`);

  // Delete old messages
  db.deleteMessages(chatId);

  // Re-index
  await indexZip(chat.originalPath || '', db, tempDir);
}