const API_BASE = '/api';
const PAGE_SIZE = 50;

// Type definitions
interface Chat {
  id: string;
  displayName: string;
  messageCount: number;
  firstMessageDate: string | null;
  lastMessageDate: string | null;
  lastMessagePreview: string | null;
}

interface Message {
  id: number;
  date: string;
  time: string;
  sender: string | null;
  text: string;
  isSystemMessage: boolean;
  mediaFilename: string | null;
  mediaType: 'image' | 'video' | 'audio' | 'document' | 'unknown' | null;
  chat_id?: string;
  chatName?: string | null;
  filename?: string;
}

interface PaginationResponse {
  messages: Message[];
  pagination: {
    offset: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
}

interface SearchResponse {
  query: string;
  results: Message[];
}

// State
let currentChatId: string | null = null;
let allChats: Chat[] = [];
let loadedMessages = new Map<number, Message>();
let hasMoreMessages = true;
let currentPage = 0;
let isFetching = false;
let messageObserver: IntersectionObserver | null = null;

// DOM elements
const chatList = document.getElementById('chatList')!;
const chatView = document.getElementById('chatView')!;
const searchInput = document.getElementById('searchInput')!;
const reindexBtn = document.getElementById('reindexBtn')!;
const searchPanel = document.getElementById('searchPanel')!;
const closeSearchBtn = document.getElementById('closeSearchBtn')!;
const messageSearchInput = document.getElementById('messageSearchInput')!;
const searchMessagesBtn = document.getElementById('searchMessagesBtn')!;
const searchResults = document.getElementById('searchResults')!;

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  await loadChats();
  setupEventListeners();
  setupIntersectionObserver();
});

async function loadChats(): Promise<void> {
  try {
    const response = await fetch(`${API_BASE}/chats`);
    if (!response.ok) throw new Error('Failed to load chats');

    allChats = await response.json();
    renderChatList(allChats);
  } catch (error) {
    chatList.innerHTML = `<div class="error">Failed to load chats: ${(error as Error).message}</div>`;
  }
}

function renderChatList(chats: Chat[]): void {
  if (chats.length === 0) {
    chatList.innerHTML = `<div class="empty-state">No chats found. Place .zip files in the watch directory.</div>`;
    return;
  }

  chatList.innerHTML = chats.map(chat => `
    <div class="chat-item ${chat.id === currentChatId ? 'active' : ''}" data-chat-id="${chat.id}">
      <div class="chat-item-name">${escapeHtml(chat.displayName)}</div>
      <div class="chat-item-preview">${escapeHtml(chat.lastMessagePreview || '')}</div>
      <div class="chat-item-meta">
        <span class="chat-item-date">${formatDate(chat.lastMessageDate)}</span>
        <span class="chat-item-count">${chat.messageCount} messages</span>
      </div>
    </div>
  `).join('');

  // Add click handlers
  document.querySelectorAll('.chat-item').forEach(item => {
    item.addEventListener('click', () => {
      const chatId = (item as HTMLElement).dataset.chatId;
      if (chatId !== currentChatId) {
        selectChat(chatId!);
      }
    });
  });
}

async function selectChat(chatId: string): Promise<void> {
  currentChatId = chatId;
  loadedMessages.clear();
  currentPage = 0;
  hasMoreMessages = true;

  // Update active state
  document.querySelectorAll('.chat-item').forEach(item => {
    item.classList.toggle('active', (item as HTMLElement).dataset.chatId === chatId);
  });

  // Show loading state
  chatView.innerHTML = `
    <div class="chat-header">
      <h2 id="currentChatName">Loading...</h2>
    </div>
    <div class="chat-messages">
      <div class="loading">Loading messages...</div>
    </div>
  `;

  try {
    const [chatResponse, messagesResponse] = await Promise.all([
      fetch(`${API_BASE}/chats/${chatId}`),
      fetch(`${API_BASE}/chats/${chatId}/messages?offset=0&limit=${PAGE_SIZE}`)
    ]);

    const chat = await chatResponse.json();
    const { messages, pagination } = await messagesResponse.json() as PaginationResponse;

    hasMoreMessages = pagination.hasMore;

    // Store messages
    messages.forEach(msg => {
      loadedMessages.set(msg.id, msg);
    });

    renderChatView(chat, messages);
  } catch (error) {
    chatView.innerHTML = `<div class="error">Failed to load chat: ${(error as Error).message}</div>`;
  }
}

function renderChatView(chat: Chat, messages: Message[]): void {
  const html = `
    <div class="chat-header">
      <h2 id="currentChatName">${escapeHtml(chat.displayName)}</h2>
      <button onclick="toggleSearchPanel()" title="Search messages">🔍</button>
    </div>
    <div class="chat-messages" id="messagesContainer">
      <div id="loadMoreTrigger"></div>
      ${messages.length === 0 ? '<div class="empty-state"><p>No messages in this chat</p></div>' : ''}
      ${messages.map(msg => renderMessage(msg)).join('')}
    </div>
  `;

  chatView.innerHTML = html;

  // Setup media click handlers
  setupMediaClickHandlers();

  // Setup intersection observer for lazy loading
  setTimeout(() => {
    const trigger = document.getElementById('loadMoreTrigger');
    if (trigger && messageObserver) {
      messageObserver.observe(trigger);
    }
  }, 0);
}

function renderMessage(msg: Message): string {
  const isSystem = msg.isSystemMessage;
  const sender = msg.sender;
  const isIncoming = sender && sender !== 'Me';

  if (isSystem) {
    return `
      <div class="message system">
        <div class="message-bubble">
          ${escapeHtml(msg.text)}
        </div>
      </div>
    `;
  }

  const mediaHtml = msg.mediaFilename ? renderMedia(msg) : '';

  return `
    <div class="message ${isIncoming ? 'incoming' : 'outgoing'}">
      <div class="message-bubble">
        ${sender ? `<div class="message-sender">${escapeHtml(sender)}</div>` : ''}
        <div class="message-text">${escapeHtml(msg.text)}</div>
        ${mediaHtml}
        <div class="message-meta">${escapeHtml(msg.date)} ${escapeHtml(msg.time)}</div>
      </div>
    </div>
  `;
}

function renderMedia(msg: Message): string {
  const { mediaFilename, mediaType } = msg;
  const mediaUrl = `${API_BASE}/media/${currentChatId}/${encodeURIComponent(mediaFilename!)}`;

  switch (mediaType) {
    case 'image':
      return `<div class="message-media"><img src="${mediaUrl}" alt="Image" loading="lazy" onclick="openImage('${mediaUrl}')"></div>`;
    case 'video':
      return `<div class="message-media"><video src="${mediaUrl}" controls></video></div>`;
    case 'audio':
      return `<div class="message-media"><audio src="${mediaUrl}" controls></audio></div>`;
    default:
      return `<div class="message-media"><a href="${mediaUrl}" target="_blank" style="color: #00a884;">📎 ${escapeHtml(mediaFilename!)}</a></div>`;
  }
}

async function loadMoreMessages(): Promise<void> {
  if (isFetching || !hasMoreMessages || !currentChatId) return;

  isFetching = true;
  currentPage++;

  try {
    const offset = currentPage * PAGE_SIZE;
    const response = await fetch(`${API_BASE}/chats/${currentChatId}/messages?offset=${offset}&limit=${PAGE_SIZE}`);

    if (!response.ok) throw new Error('Failed to load more messages');

    const { messages, pagination } = await response.json() as PaginationResponse;
    hasMoreMessages = pagination.hasMore;

    if (messages.length === 0) {
      isFetching = false;
      return;
    }

    // Store new messages
    messages.forEach(msg => {
      loadedMessages.set(msg.id, msg);
    });

    // Insert messages at the beginning (older messages)
    const container = document.getElementById('messagesContainer')!;
    const trigger = document.getElementById('loadMoreTrigger')!;

    const newHtml = messages.map(msg => renderMessage(msg)).join('');

    // Preserve scroll position
    const scrollHeight = container.scrollHeight;
    const scrollTop = container.scrollTop;

    trigger.insertAdjacentHTML('afterend', newHtml);

    // Restore scroll position adjusted for new content
    container.scrollTop = scrollTop + (container.scrollHeight - scrollHeight);

    setupMediaClickHandlers();
  } catch (error) {
    console.error('Error loading more messages:', error);
  } finally {
    isFetching = false;
  }
}

function setupIntersectionObserver(): void {
  messageObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        loadMoreMessages();
      }
    });
  }, {
    rootMargin: '100px'
  });
}

function setupEventListeners(): void {
  // Filter chats
  searchInput.addEventListener('input', (e) => {
    const query = (e.target as HTMLInputElement).value.toLowerCase();
    const filtered = allChats.filter(chat =>
      chat.displayName.toLowerCase().includes(query)
    );
    renderChatList(filtered);
  });

  // Reindex all chats
  reindexBtn.addEventListener('click', async () => {
    (reindexBtn as HTMLButtonElement).disabled = true;
    try {
      await fetch(`${API_BASE}/reindex`, { method: 'POST' });
      await loadChats();
    } catch (error) {
      alert('Failed to reindex: ' + (error as Error).message);
    } finally {
      (reindexBtn as HTMLButtonElement).disabled = false;
    }
  });

  // Search panel
  closeSearchBtn.addEventListener('click', () => {
    searchPanel.classList.add('hidden');
  });

  searchMessagesBtn.addEventListener('click', searchMessages);
  messageSearchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') searchMessages();
  });
}

function toggleSearchPanel(): void {
  searchPanel.classList.toggle('hidden');
  if (!searchPanel.classList.contains('hidden')) {
    messageSearchInput.focus();
  }
}

async function searchMessages(): Promise<void> {
  const query = (messageSearchInput as HTMLInputElement).value.trim();
  if (!query) return;

  searchResults.innerHTML = '<div class="loading">Searching...</div>';

  try {
    const response = await fetch(`${API_BASE}/search?q=${encodeURIComponent(query)}&chatId=${currentChatId || ''}`);
    if (!response.ok) throw new Error('Search failed');

    const { results } = await response.json() as SearchResponse;

    if (results.length === 0) {
      searchResults.innerHTML = '<div class="empty-state">No results found</div>';
      return;
    }

    searchResults.innerHTML = results.map(result => `
      <div class="search-result-item" data-msg-id="${result.id}" data-chat-id="${result.chat_id}">
        <div class="search-result-chat">${escapeHtml(result.chatName || result.filename || '')}</div>
        <div class="search-result-text">${escapeHtml(result.text)}</div>
        <div class="search-result-meta">${escapeHtml(result.date)} ${escapeHtml(result.time)}</div>
      </div>
    `).join('');

    // Click handler to jump to message
    document.querySelectorAll('.search-result-item').forEach(item => {
      item.addEventListener('click', () => {
        const chatId = (item as HTMLElement).dataset.chatId;
        if (chatId !== currentChatId) {
          selectChat(chatId!);
        }
        searchPanel.classList.add('hidden');
      });
    });
  } catch (error) {
    searchResults.innerHTML = `<div class="error">Search failed: ${(error as Error).message}</div>`;
  }
}

function setupMediaClickHandlers(): void {
  document.querySelectorAll('.message-media img').forEach(img => {
    img.addEventListener('click', () => {
      window.open((img as HTMLImageElement).src, '_blank');
    });
  });
}

function openImage(url: string): void {
  window.open(url, '_blank');
}

// Make functions globally available for onclick handlers
(window as any).toggleSearchPanel = toggleSearchPanel;
(window as any).openImage = openImage;

// Utility functions
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  return date.toLocaleDateString();
}