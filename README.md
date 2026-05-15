# WhatsApp Export Viewer

A local web application to view WhatsApp chat exports (`.zip` files) with a WhatsApp-style UI and lazy loading. Built with TypeScript.

## Features

- **Auto-detection**: Monitors a directory for new `.zip` files and indexes them automatically
- **WhatsApp-style UI**: Dark theme matching WhatsApp's design
- **Lazy loading**: Uses `IntersectionObserver` to load messages as you scroll
- **Full-text search**: Search across all messages using SQLite FTS5
- **Media support**: View images, videos, and audio from exports
- **Fast indexing**: SQLite database for instant pagination and search

## Installation

```bash
npm install
```

## Usage

### Option 1: Docker (Recommended)

**Using pre-built image:**

1. Place your WhatsApp `.zip` export files in the `./whatsapp-exports` directory (or mount your own volume)
2. Start with Docker Compose:

```bash
docker-compose up -d
```

**Building locally (development):**

Use `docker-compose.dev.yml` to build from source:

```bash
docker-compose -f docker-compose.dev.yml up -d
```

Or build and run manually:

```bash
docker build -t whatsapp-export-viewer .
docker run -d \
  -p 3000:3000 \
  -v $(pwd)/whatsapp-exports:/app/whatsapp-exports \
  -v $(pwd)/data:/app/data \
  whatsapp-export-viewer
```

3. Open http://localhost:3000 in your browser

### Option 2: Local Node.js

1. Create a directory for your WhatsApp exports (default: `./whatsapp-exports`)
2. Place your WhatsApp `.zip` export files in that directory
3. Build and start the server:

```bash
npm run build
npm start
```

For development with hot reload:

```bash
npm run dev
```

4. Open http://localhost:3000 in your browser

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `WHATSAPP_EXPORTS_DIR` | `./whatsapp-exports` | Directory to watch for `.zip` files |
| `TEMP_DIR` | `./.temp` | Temporary extraction directory |
| `DB_PATH` | `./whatsapp.db` | SQLite database file path (in Docker: `/app/data/whatsapp.db`) |
| `PORT` | `3000` | Server port |
| `REINDEX_ON_STARTUP` | `false` | Reindex all zips on server startup |

## API Endpoints

- `GET /api/health` - Health check
- `GET /api/chats` - List all chats
- `GET /api/chats/:id` - Get chat details
- `GET /api/chats/:id/messages?offset=0&limit=50` - Get paginated messages
- `GET /api/search?q=query&chatId=optional` - Search messages
- `GET /api/media/:chatId/:filename` - Serve media files
- `POST /api/chats/:id/reindex` - Reindex a specific chat
- `POST /api/reindex` - Reindex all chats

## Project Structure

```
whatsapp-export-viewer/
├── src/
│   ├── server/          # Backend (TypeScript)
│   │   ├── index.ts     # Main server with Express + APIs
│   │   ├── config.ts    # Configuration
│   │   ├── database.ts  # SQLite database operations
│   │   ├── parser.ts    # WhatsApp .txt parsing + zip extraction
│   │   ├── indexer.ts   # Reindexing logic
│   │   └── watcher.ts   # File system monitoring
│   └── public/          # Frontend
│       ├── index.html    # Main HTML
│       ├── styles.css    # WhatsApp-style CSS
│       └── app.ts       # Frontend logic (lazy loading, search)
├── dist/               # Compiled JavaScript (build output)
├── whatsapp.db          # SQLite database (auto-created)
├── .temp/              # Temporary extractions (auto-cleaned)
└── whatsapp-exports/    # Place your .zip files here
```

## Development

The project uses TypeScript for both backend and frontend.

- **Backend**: Compiled with `tsc` to ES2022 modules
- **Frontend**: Bundled with `esbuild` to ES2020 for browser compatibility

Build scripts:
- `npm run build` - Build both server and client
- `npm run build:server` - Build server only
- `npm run build:client` - Build client only
- `npm run dev` - Watch and rebuild both automatically

## Docker

The project includes a `Dockerfile` for containerized deployment.

### Docker Compose

```bash
# Start the service
docker-compose up -d

# View logs
docker-compose logs -f

# Stop the service
docker-compose down
```

### Custom Ports

Edit `docker-compose.yml` to change the port:

```yaml
ports:
  - "8080:3000"  # Access on port 8080
```

### Environment Variables

You can override environment variables in `docker-compose.yml`:

```yaml
environment:
  - PORT=3000
  - REINDEX_ON_STARTUP=true  # Reindex on container start
```

## Notes

- The parser handles hidden Unicode characters (like `‎`) in sender names
- Media files are extracted on-demand and cached for 5 minutes
- Temporary files are cleaned up on server shutdown
- Click the reindex button to manually refresh all chats
- In Docker, the `whatsapp-exports` volume persists across container restarts# whatsapp-export-viewer
# whatsapp-export-viewer
