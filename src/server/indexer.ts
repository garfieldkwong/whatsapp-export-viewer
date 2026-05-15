import { extractAndParseZip, parseTextFile } from './parser.js';
import { join, basename, dirname } from 'path';
import { WhatsAppDatabase } from './database.js';
import { readdirSync, statSync, rmSync, existsSync } from 'fs';
import { createHash } from 'crypto';

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
      console.log(`  No messages found in ${txtFile}`);
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

    console.log(`  Indexed ${messages.length} messages for ${txtFile}`);
  }
}

// Index a single zip file
export async function indexZip(zipPath: string, db: WhatsAppDatabase, tempDir: string): Promise<void> {
  const filename = basename(zipPath);
  const isZip = zipPath.endsWith('.zip');

  console.log(`[DEBUG] Starting to index: ${filename}`);
  console.log(`[DEBUG] Is zip: ${isZip}`);
  console.log(`[DEBUG] Temp dir: ${tempDir}`);

  if (isZip) {
    try {
      console.log(`[DEBUG] Calling extractAndParseZip for ${filename}...`);
      const { chatId, extractDir, txtFile, messages, mediaFiles } = await extractAndParseZip(zipPath, tempDir);
      console.log(`[DEBUG] Extracted: chatId=${chatId}, txtFile=${txtFile}, messages=${messages.length}, mediaFiles=${mediaFiles.length}`);

      if (messages.length === 0) {
        console.log(`  No messages found in ${txtFile}`);
        return;
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
        isZip: true,
      };

      console.log(`[DEBUG] Upserting chat ${chatId}...`);
      db.upsertChat(chat);
      console.log(`[DEBUG] Chat upserted, inserting ${messages.length} messages...`);
      db.insertMessages(messages);
      console.log(`[DEBUG] Messages inserted successfully`);
      console.log(`  Indexed ${messages.length} messages for ${txtFile}`);

      if (mediaFiles.length > 0) {
        console.log(`  ${mediaFiles.length} media files available`);
      }
    } catch (error) {
      console.error(`  Error indexing ${filename}:`, error instanceof Error ? error.message : String(error));
      console.error(`[DEBUG] Stack:`, error instanceof Error ? error.stack : 'No stack');
      throw error;
    }
  } else {
    // Handle standalone txt file (not in zip)
    const chatId = createChatId(filename);
    const messages = parseTextFile(zipPath, chatId);

    if (messages.length === 0) {
      console.log(`  No messages found in ${filename}`);
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
    console.log(`  Indexed ${messages.length} messages for ${filename}`);
  }
  console.log(`[DEBUG] Finished indexing: ${filename}`);
}

// Re-index all zip and txt files in a directory
export async function reindexAll(directory: string, db: WhatsAppDatabase, tempDir: string): Promise<void> {
  const files = readdirSync(directory).filter(f => f.endsWith('.zip') || f.endsWith('.txt'));

  console.log(`Found ${files.length} files to index`);

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