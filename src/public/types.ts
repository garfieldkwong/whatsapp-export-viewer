export interface Chat {
  id: string;
  displayName: string;
  messageCount: number;
  firstMessageDate: string | null;
  lastMessageDate: string | null;
  lastMessagePreview: string | null;
}

export interface Message {
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

export interface PaginationResponse {
  messages: Message[];
  pagination: {
    offset: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
}

export interface SearchResponse {
  query: string;
  results: Message[];
}
