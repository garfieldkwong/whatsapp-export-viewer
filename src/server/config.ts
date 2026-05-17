export interface Config {
  WATCH_DIR: string;
  TEMP_DIR: string;
  DB_PATH: string;
  PORT: number | string;
  DEFAULT_PAGE_SIZE: number;
  REINDEX_ON_STARTUP: boolean;
  SSL_CERT_PATH: string;
  SSL_KEY_PATH: string;
}

export const CONFIG: Config = {
  WATCH_DIR: process.env.WHATSAPP_EXPORTS_DIR || './whatsapp-exports',
  TEMP_DIR: process.env.TEMP_DIR || './.temp',
  DB_PATH: process.env.DB_PATH || './whatsapp.db',
  PORT: process.env.PORT || 3000,
  DEFAULT_PAGE_SIZE: 50,
  REINDEX_ON_STARTUP: process.env.REINDEX_ON_STARTUP === 'true',
  SSL_CERT_PATH: process.env.SSL_CERT_PATH || '',
  SSL_KEY_PATH: process.env.SSL_KEY_PATH || '',
};