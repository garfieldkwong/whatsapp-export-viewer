import type { Chat, Message, PaginationResponse, SearchResponse } from '../types';

const API_BASE = '/api';

export async function fetchChats(): Promise<Chat[]> {
  const response = await fetch(`${API_BASE}/chats`);
  if (!response.ok) throw new Error('Failed to load chats');
  return response.json();
}

export async function fetchChat(chatId: string): Promise<Chat> {
  const response = await fetch(`${API_BASE}/chats/${chatId}`);
  if (!response.ok) throw new Error('Failed to load chat');
  return response.json();
}

export async function fetchMessages(chatId: string, offset: number, limit: number): Promise<PaginationResponse> {
  const response = await fetch(`${API_BASE}/chats/${chatId}/messages?offset=${offset}&limit=${limit}`);
  if (!response.ok) throw new Error('Failed to load messages');
  return response.json();
}

export async function searchMessages(query: string, chatId: string | null): Promise<Message[]> {
  const params = new URLSearchParams({ q: query });
  if (chatId) params.set('chatId', chatId);
  const response = await fetch(`${API_BASE}/search?${params}`);
  if (!response.ok) throw new Error('Search failed');
  const data: SearchResponse = await response.json();
  return data.results;
}

export async function reindexAll(): Promise<void> {
  const response = await fetch(`${API_BASE}/reindex`, { method: 'POST' });
  if (!response.ok) throw new Error('Failed to reindex');
}

export function getMediaUrl(chatId: string, filename: string): string {
  return `${API_BASE}/media/${chatId}/${encodeURIComponent(filename)}`;
}
