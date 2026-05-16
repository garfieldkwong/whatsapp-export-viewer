<script setup lang="ts">
import { ref } from 'vue';
import ChatList from './components/ChatList.vue';
import ChatView from './components/ChatView.vue';

const currentChatId = ref<string | null>(null);

function onSelectChat(chatId: string) {
  currentChatId.value = chatId;
}
</script>

<template>
  <div class="app">
    <ChatList :current-chat-id="currentChatId" @select-chat="onSelectChat" />
    <ChatView :chat-id="currentChatId" />
  </div>
</template>
