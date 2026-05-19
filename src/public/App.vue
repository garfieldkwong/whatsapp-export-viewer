<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue';
import ChatList from './components/ChatList.vue';
import ChatView from './components/ChatView.vue';

const MOBILE_BREAKPOINT = 768;

const currentChatId = ref<string | null>(null);
const showSidebar = ref(true);
const isMobile = ref(typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT);
let skipPopState = false;

function checkMobile() {
  const wasMobile = isMobile.value;
  isMobile.value = window.innerWidth < MOBILE_BREAKPOINT;
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
    history.pushState({ chatView: true }, '');
  }
}

function onBackToList() {
  if (isMobile.value) {
    skipPopState = true;
    history.back();
    showSidebar.value = true;
    currentChatId.value = null;
  }
}

function onPopState() {
  if (skipPopState) {
    skipPopState = false;
    return;
  }
  if (isMobile.value && currentChatId.value !== null) {
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
  window.addEventListener('popstate', onPopState);
});

onUnmounted(() => {
  window.removeEventListener('resize', checkMobile);
  window.removeEventListener('popstate', onPopState);
});
</script>

<template>
  <div class="app" :class="{ 'mobile-layout': isMobile, 'sidebar-visible': showSidebar }">
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
