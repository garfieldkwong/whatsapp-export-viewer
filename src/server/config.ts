export interface Config {
  WATCH_DIR: string;
  TEMP_DIR: string;
  DB_PATH: string;
  PORT: number | string;
  DEFAULT_PAGE_SIZE: number;
  REINDEX_ON_STARTUP: boolean;
}

export const CONFIG: Config = {
  // Directory to monitor for WhatsApp .zip exports
  WATCH_DIR: process.env.WHATSAPP_EXPORTS_DIR || './whatsapp-exports',

  // Temporary extraction directory (auto-cleaned on startup)
  TEMP_DIR: process.env.TEMP_DIR || './.temp',

  // SQLite database file
  DB_PATH: process.env.DB_PATH || './whatsapp.db',

  // Server port
  PORT: process.env.PORT || 3000,

  // Pagination default page size
  DEFAULT_PAGE_SIZE: 50,

  // Whether to reindex all zips on startup
  REINDEX_ON_STARTUP: process.env.REINDEX_ON_STARTUP === 'true',
};