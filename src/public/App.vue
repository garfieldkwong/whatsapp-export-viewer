<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue';
import ChatList from './components/ChatList.vue';
import ChatView from './components/ChatView.vue';

const currentChatId = ref<string | null>(null);
const showSidebar = ref(true);
const isMobile = ref(false);

function checkMobile() {
  const wasMobile = isMobile.value;
  isMobile.value = window.innerWidth < 768;
  if (!isMobile.value) {
    showSidebar.value = true;
  } else if (!wasMobile && currentChatId.value) {
    showSidebar.value = false;
  }
}

function onSelectChat(chatId: string) {
  currentChatId.value = chatId;
  if (isMobile.value) {
    showSidebar.value = false;
  }
}

function onBackToList() {
  if (isMobile.value) {
    showSidebar.value = true;
    currentChatId.value = null;
  }
}

watch(currentChatId, (newId) => {
  if (!newId && isMobile.value) {
    showSidebar.value = true;
  }
});

onMounted(() => {
  checkMobile();
  window.addEventListener('resize', checkMobile);
});

onUnmounted(() => {
  window.removeEventListener('resize', checkMobile);
});
</script>

<template>
  <div class="app" :class="{ 'sidebar-visible': showSidebar }">
    <ChatList
      :current-chat-id="currentChatId"
      :class="{ 'mobile-hidden': isMobile && !showSidebar }"
      @select-chat="onSelectChat"
    />
    <ChatView
      :chat-id="currentChatId"
      :class="{ 'mobile-hidden': isMobile && showSidebar }"
      @back="onBackToList"
    />
  </div>
</template>
