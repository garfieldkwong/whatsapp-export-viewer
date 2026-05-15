import Database from 'better-sqlite3';
import { CONFIG } from './config.js';
import { MediaType } from './parser.js';

export interface Chat {
  id: string;
  filename: string;
  originalPath?: string;
  displayName: string;
  messageCount: number;
  firstMessageDate: string | null;
  lastMessageDate: string | null;
  lastMessagePreview: string | null;
}

export interface ChatInput {
  id: string;
  filename: string;
  originalPath: string;
  displayName: string;
  messageCount: number;
  firstMessageDate: string | null;
  lastMessageDate: string | null;
  lastMessagePreview: string | null;
}

export interface MessageOutput {
  chatId: string;
  id: number;
  date: string;
  time: string;
  sender: string | null;
  text: string;
  isSystemMessage: boolean;
  mediaFilename: string | null;
  mediaType: MediaType | null;
  position: number;
}

export interface MessageInput {
  chatId: string;
  position: number;
  date: string;
  time: string;
  sender: string | null;
  text: string;
  isSystemMessage: boolean;
  mediaFilename: string | null;
  mediaType: MediaType | null;
}

export interface SearchResult {
  id: number;
  date: string;
  time: string;
  sender: string | null;
  text: string;
  isSystemMessage: boolean;
  mediaFilename: string | null;
  mediaType: MediaType | null;
  chatName: string | null;
  filename: string;
}

export interface PaginationResult {
  messages: MessageOutput[];
  pagination: {
    offset: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
}

export class WhatsAppDatabase {
  private db: Database.Database;

  constructor() {
    this.db = new Database(CONFIG.DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initSchema();
  }

  private initSchema(): void {
    // Chats table - stores info about each zip file/chat
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        original_path TEXT NOT NULL,
        display_name TEXT,
        message_count INTEGER DEFAULT 0,
        first_message_date TEXT,
        last_message_date TEXT,
        last_message_preview TEXT,
        indexed_at INTEGER NOT NULL,
        UNIQUE (filename)
      );
    `);

    // Messages table - stores individual messages
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        sender TEXT,
        text TEXT,
        is_system_message INTEGER DEFAULT 0,
        media_filename TEXT,
        media_type TEXT,
        FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
      );
    `);

    // Indexes for queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_chat_position ON messages(chat_id, position);
      CREATE INDEX IF NOT EXISTS idx_messages_chat_date ON messages(chat_id, date DESC);
    `);

    // Full-text search for message content
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        message_id,
        text,
        content='messages',
        content_rowid='id'
      );
    `);

    // Triggers to keep FTS in sync
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages
      BEGIN
        INSERT INTO messages_fts(rowid, message_id, text)
        VALUES (NEW.id, NEW.id, NEW.text);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages
      BEGIN
        DELETE FROM messages_fts WHERE rowid = OLD.id;
      END;

      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages
      BEGIN
        DELETE FROM messages_fts WHERE rowid = OLD.id;
        INSERT INTO messages_fts(rowid, message_id, text)
        VALUES (NEW.id, NEW.id, NEW.text);
      END;
    `);
  }

  // Insert or update a chat
  upsertChat(chat: ChatInput): Database.RunResult {
    const stmt = this.db.prepare(`
      INSERT INTO chats (id, filename, original_path, display_name, message_count,
                         first_message_date, last_message_date, last_message_preview, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(filename) DO UPDATE SET
        message_count = excluded.message_count,
        first_message_date = excluded.first_message_date,
        last_message_date = excluded.last_message_date,
        last_message_preview = excluded.last_message_preview,
        indexed_at = excluded.indexed_at
    `);
    return stmt.run(
      chat.id,
      chat.filename,
      chat.originalPath,
      chat.displayName,
      chat.messageCount,
      chat.firstMessageDate,
      chat.lastMessageDate,
      chat.lastMessagePreview,
      Date.now()
    );
  }

  // Insert messages in batch for performance
  insertMessages(messages: MessageInput[]): void {
    const insert = this.db.prepare(`
      INSERT INTO messages (chat_id, position, date, time, sender, text,
                           is_system_message, media_filename, media_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMany = this.db.transaction((msgs: MessageInput[]) => {
      for (const msg of msgs) {
        insert.run(
          msg.chatId,
          msg.position,
          msg.date,
          msg.time,
          msg.sender || null,
          msg.text,
          msg.isSystemMessage ? 1 : 0,
          msg.mediaFilename || null,
          msg.mediaType || null
        );
      }
    });
    insertMany(messages);
  }

  // Delete all messages for a chat
  deleteMessages(chatId: string): Database.RunResult {
    const stmt = this.db.prepare('DELETE FROM messages WHERE chat_id = ?');
    return stmt.run(chatId);
  }

  // Delete a chat
  deleteChat(chatId: string): Database.RunResult {
    const stmt = this.db.prepare('DELETE FROM chats WHERE id = ?');
    return stmt.run(chatId);
  }

  // Get all chats
  getAllChats(): Chat[] {
    const stmt = this.db.prepare(`
      SELECT id, filename, display_name as displayName, message_count as messageCount,
             first_message_date as firstMessageDate, last_message_date as lastMessageDate,
             last_message_preview as lastMessagePreview
      FROM chats
      ORDER BY last_message_date DESC
    `);
    return stmt.all() as Chat[];
  }

  // Get a single chat
  getChat(chatId: string): Chat | undefined {
    const stmt = this.db.prepare(`
      SELECT id, filename, display_name as displayName, message_count as messageCount,
             first_message_date as firstMessageDate, last_message_date as lastMessageDate,
             last_message_preview as lastMessagePreview
      FROM chats WHERE id = ?
    `);
    return stmt.get(chatId) as Chat | undefined;
  }

  // Get messages with pagination (for lazy loading)
  getMessages(chatId: string, offset: number = 0, limit: number = 50): MessageOutput[] {
    const stmt = this.db.prepare(`
      SELECT id, date, time, sender, text,
             is_system_message as isSystemMessage,
             media_filename as mediaFilename, media_type as mediaType
      FROM messages
      WHERE chat_id = ?
      ORDER BY position DESC
      LIMIT ? OFFSET ?
    `);
    return stmt.all(chatId, limit, offset) as MessageOutput[];
  }

  // Get message count for a chat
  getMessageCount(chatId: string): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM messages WHERE chat_id = ?');
    const result = stmt.get(chatId) as { count: number } | undefined;
    return result?.count || 0;
  }

  // Search messages
  searchMessages(query: string, chatId: string | null = null): SearchResult[] {
    let sql = `
      SELECT m.*, c.display_name as chatName, c.filename
      FROM messages_fts fts
      JOIN messages m ON fts.message_id = m.id
      JOIN chats c ON m.chat_id = c.id
      WHERE messages_fts MATCH ?
    `;
    const params: (string | null)[] = [query];

    if (chatId) {
      sql += ' AND m.chat_id = ?';
      params.push(chatId);
    }

    sql += ' ORDER BY m.position DESC LIMIT 100';

    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as SearchResult[];
  }

  close(): void {
    this.db.close();
  }
}