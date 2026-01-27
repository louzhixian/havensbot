import type { DiarySession } from "../db.js";

export type DiaryMessage = {
  role: "bot" | "user";
  content: string;
  timestamp: Date;
};

export type DiaryConversation = {
  session: DiarySession;
  messages: DiaryMessage[];
};

export type DiaryExportResult = {
  localPath: string;
  markdownContent: string;
};

export type DiaryStartResult = {
  session: DiarySession;
  threadId: string;
  openingMessage: string;
};

export type DiaryEndResult = {
  session: DiarySession;
  exportResult: DiaryExportResult;
  messageCount: number;
};
