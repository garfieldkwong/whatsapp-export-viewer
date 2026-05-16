<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import type { Chat, Message } from '../types';
import { fetchChat, fetchMessages } from '../composables/api';
import MessageBubble from './MessageBubble.vue';
import SearchPanel from './SearchPanel.vue';

const PAGE_SIZE = 50;

const props = defineProps<{
  chatId: string | null;
}>();

const chat = ref<Chat | null>(null);
const messages = ref<Message[]>([]);
const hasMore = ref(true);
const isLoading = ref(false);
const error = ref<string | null>(null);
const isFetchingMore = ref(false);
const messagesContainer = ref<HTMLElement | null>(null);
const loadMoreTrigger = ref<HTMLElement | null>(null);
const showSearch = ref(false);

let observer: IntersectionObserver | null = null;
let currentPage = 0;

function setupObserver() {
  if (observer) observer.disconnect();
  observer = new IntersectionObserver(
    (entries) => {
      if (entries[0]?.isIntersecting) loadMore();
    },
    { rootMargin: '100px' }
  );
  if (loadMoreTrigger.value) {
    observer.observe(loadMoreTrigger.value);
  }
}

async function loadChat(chatId: string) {
  isLoading.value = true;
  error.value = null;
  messages.value = [];
  currentPage = 0;
  hasMore.value = true;
  showSearch.value = false;

  try {
    const [chatData, response] = await Promise.all([
      fetchChat(chatId),
      fetchMessages(chatId, 0, PAGE_SIZE),
    ]);
    chat.value = chatData;
    messages.value = response.messages;
    hasMore.value = response.pagination.hasMore;

    await nextTick();
    setupObserver();
    scrollToBottom();
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    isLoading.value = false;
  }
}

async function loadMore() {
  if (isFetchingMore.value || !hasMore.value || !props.chatId) return;
  isFetchingMore.value = true;
  currentPage++;

  try {
    const offset = currentPage * PAGE_SIZE;
    const response = await fetchMessages(props.chatId, offset, PAGE_SIZE);
    hasMore.value = response.pagination.hasMore;
    if (response.messages.length === 0) return;

    const container = messagesContainer.value;
    const prevScrollHeight = container?.scrollHeight || 0;
    const prevScrollTop = container?.scrollTop || 0;

    messages.value = [...response.messages, ...messages.value];

    await nextTick();
    if (container) {
      container.scrollTop = prevScrollTop + (container.scrollHeight - prevScrollHeight);
    }
  } catch (err) {
    console.error('Error loading more messages:', err);
  } finally {
    isFetchingMore.value = false;
  }
}

function scrollToBottom() {
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
    }
  });
}

watch(
  () => props.chatId,
  (newId) => {
    if (newId) loadChat(newId);
  }
);
</script>

<template>
  <main class="chat-view">
    <div v-if="!chatId" class="empty-state">
      <div class="empty-icon">💬</div>
      <h2>Select a chat to view</h2>
      <p>Choose from the list on the left</p>
    </div>

    <template v-else>
      <div v-if="isLoading" class="loading">Loading messages...</div>
      <div v-else-if="error" class="error">Failed to load chat: {{ error }}</div>
      <template v-else-if="chat">
        <div class="chat-header">
          <h2>{{ chat.displayName }}</h2>
          <button @click="showSearch = !showSearch" title="Search messages">🔍</button>
        </div>
        <div ref="messagesContainer" class="chat-messages">
          <div ref="loadMoreTrigger" />
          <div v-if="messages.length === 0" class="empty-state">
            <p>No messages in this chat</p>
          </div>
          <MessageBubble
            v-for="msg in messages"
            :key="msg.id"
            :message="msg"
            :chat-id="chatId"
          />
        </div>
        <SearchPanel
          v-if="showSearch"
          :current-chat-id="chatId"
          @close="showSearch = false"
        />
      </template>
    </template>
  </main>
</template>
