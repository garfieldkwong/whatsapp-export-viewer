<script setup lang="ts">
import { ref } from 'vue';
import type { Message } from '../types';
import { searchMessages } from '../composables/api';
import { escapeHtml } from '../composables/utils';

const props = defineProps<{
  currentChatId: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const query = ref('');
const results = ref<Message[]>([]);
const isSearching = ref(false);
const error = ref<string | null>(null);

async function doSearch() {
  const q = query.value.trim();
  if (!q) return;

  isSearching.value = true;
  error.value = null;

  try {
    results.value = await searchMessages(q, props.currentChatId);
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    isSearching.value = false;
  }
}

function handleKey(e: KeyboardEvent) {
  if (e.key === 'Enter') doSearch();
}
</script>

<template>
  <div class="search-panel">
    <div class="search-panel-header">
      <button class="close-btn" @click="emit('close')">&times;</button>
      <h3>Search Results</h3>
      <input
        v-model="query"
        type="text"
        placeholder="Search messages..."
        @keypress="handleKey"
      />
      <button @click="doSearch">Search</button>
    </div>
    <div class="search-results">
      <div v-if="isSearching" class="loading">Searching...</div>
      <div v-else-if="error" class="error">Search failed: {{ error }}</div>
      <div v-else-if="results.length === 0 && query" class="empty-state">No results found</div>
      <div
        v-for="result in results"
        :key="result.id"
        class="search-result-item"
      >
        <div class="search-result-chat" v-html="escapeHtml(result.chatName || result.filename || '')" />
        <div class="search-result-text" v-html="escapeHtml(result.text)" />
        <div class="search-result-meta">{{ result.date }} {{ result.time }}</div>
      </div>
    </div>
  </div>
</template>
