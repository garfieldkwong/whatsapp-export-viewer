<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import type { Chat } from '../types';
import { fetchChats, fetchFolders, reindexAll } from '../composables/api';
import { formatDate, escapeHtml } from '../composables/utils';

const props = defineProps<{
  currentChatId: string | null;
}>();

const emit = defineEmits<{
  (e: 'select-chat', chatId: string): void;
}>();

const allChats = ref<Chat[]>([]);
const folders = ref<string[]>([]);
const selectedFolder = ref<string | null>(null);
const searchQuery = ref('');
const error = ref<string | null>(null);
const isReindexing = ref(false);

const filteredChats = computed(() => {
  const query = searchQuery.value.toLowerCase();
  let chats = allChats.value;
  if (query) {
    chats = chats.filter(chat =>
      chat.displayName.toLowerCase().includes(query)
    );
  }
  return chats;
});

const folderDisplayName = computed(() => (folder: string) => {
  return folder.split('/').pop() || folder;
});

async function loadFolders() {
  try {
    folders.value = await fetchFolders();
  } catch {
    folders.value = [];
  }
}

async function loadChats() {
  try {
    error.value = null;
    allChats.value = await fetchChats(selectedFolder.value);
  } catch (err) {
    error.value = (err as Error).message;
  }
}

async function onFolderChange() {
  await loadChats();
}

async function handleReindex() {
  isReindexing.value = true;
  try {
    await reindexAll();
    await loadFolders();
    await loadChats();
  } catch (err) {
    alert('Failed to reindex: ' + (err as Error).message);
  } finally {
    isReindexing.value = false;
  }
}

const sidebar = ref<HTMLElement | null>(null);

function onResizeMouseDown(e: MouseEvent) {
  if (window.innerWidth < 768) return;
  e.preventDefault();
  const sidebarEl = sidebar.value;
  if (!sidebarEl) return;
  const startX = e.clientX;
  const startWidth = sidebarEl.offsetWidth;
  const handle = e.target as HTMLElement;
  handle.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';

  function onMouseMove(ev: MouseEvent) {
    const newWidth = Math.min(600, Math.max(250, startWidth + ev.clientX - startX));
    sidebarEl.style.width = `${newWidth}px`;
  }

  function onMouseUp() {
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
}

function onResize() {
  if (window.innerWidth < 768 && sidebar.value) {
    sidebar.value.style.width = '';
  }
}

onMounted(() => {
  loadFolders();
  loadChats();
  window.addEventListener('resize', onResize);
});

onUnmounted(() => {
  window.removeEventListener('resize', onResize);
});
</script>

<template>
  <aside ref="sidebar" class="sidebar">
    <div
      class="sidebar-resize-handle"
      @mousedown="onResizeMouseDown"
    />
    <div class="sidebar-header">
      <h1>WhatsApp Export Viewer</h1>
      <button
        class="icon-btn"
        title="Reindex all chats"
        :disabled="isReindexing"
        @click="handleReindex"
      >
        🔄
      </button>
    </div>
    <div v-if="folders.length > 0" class="folder-bar">
      <button
        class="folder-btn"
        :class="{ active: selectedFolder === null }"
        @click="selectedFolder = null; onFolderChange()"
      >
        All
      </button>
      <button
        v-for="folder in folders"
        :key="folder"
        class="folder-btn"
        :class="{ active: selectedFolder === folder }"
        @click="selectedFolder = folder; onFolderChange()"
      >
        {{ folderDisplayName(folder) }}
      </button>
    </div>
    <div class="search-box">
      <input
        v-model="searchQuery"
        type="text"
        placeholder="Search chats..."
      />
    </div>
    <div class="chat-list">
      <div v-if="error" class="error">Failed to load chats: {{ error }}</div>
      <div v-else-if="filteredChats.length === 0 && allChats.length === 0" class="empty-state">
        No chats found. Place .zip files in the watch directory.
      </div>
      <div v-else-if="filteredChats.length === 0" class="empty-state">
        No chats match your search.
      </div>
      <div
        v-for="chat in filteredChats"
        :key="chat.id"
        class="chat-item"
        :class="{ active: chat.id === currentChatId }"
        @click="emit('select-chat', chat.id)"
      >
        <div class="chat-item-name" v-html="escapeHtml(chat.displayName)" />
        <div class="chat-item-preview" v-html="escapeHtml(chat.lastMessagePreview || '')" />
        <div class="chat-item-meta">
          <span class="chat-item-date">{{ formatDate(chat.lastMessageDate) }}</span>
          <span class="chat-item-count">{{ chat.messageCount }} messages</span>
        </div>
      </div>
    </div>
  </aside>
</template>
