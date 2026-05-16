<script setup lang="ts">
import { computed } from 'vue';
import type { Message } from '../types';
import { getMediaUrl } from '../composables/api';
import { escapeHtml } from '../composables/utils';

const props = defineProps<{
  message: Message;
  chatId: string;
}>();

const isIncoming = computed(() => props.message.sender && props.message.sender !== 'Me');
const mediaUrl = computed(() =>
  props.message.mediaFilename
    ? getMediaUrl(props.chatId, props.message.mediaFilename)
    : ''
);
</script>

<template>
  <div class="message" :class="{ system: message.isSystemMessage, incoming: isIncoming, outgoing: !isIncoming && !message.isSystemMessage }">
    <div class="message-bubble">
      <div v-if="!message.isSystemMessage && message.sender" class="message-sender" v-html="escapeHtml(message.sender)" />
      <div class="message-text" v-html="escapeHtml(message.text)" />
      <div v-if="message.mediaFilename" class="message-media">
        <img
          v-if="message.mediaType === 'image'"
          :src="mediaUrl"
          alt="Image"
          loading="lazy"
          @click="window.open(mediaUrl, '_blank')"
        />
        <video v-else-if="message.mediaType === 'video'" :src="mediaUrl" controls />
        <audio v-else-if="message.mediaType === 'audio'" :src="mediaUrl" controls />
        <a v-else :href="mediaUrl" target="_blank" style="color: #00a884;">📎 <span v-html="escapeHtml(message.mediaFilename)" /></a>
      </div>
      <div class="message-meta">{{ message.date }} {{ message.time }}</div>
    </div>
  </div>
</template>
