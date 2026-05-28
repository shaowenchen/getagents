// Core types for GetAgents — AgentHome ZIP package management platform

export interface AgentConfig {
  id: string;
  userId: string;
  name: string;
  type: string;
  avatar?: string;
  description: string;
  filename: string;
  fileSize: number;
  fileHash: string;
  tags?: string[];
  isPublic: boolean;
  publishedVersion?: number;
  downloadCount: number;
  likesCount: number;
  shareToken?: string;
  sharePassword?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentVersion {
  id: string;
  agentId: string;
  version: number;
  snapshot: AgentSnapshot;
  comment?: string;
  isPublished: boolean;
  createdAt: number;
}

export interface AgentSnapshot {
  name: string;
  type?: string;
  description: string;
  filename: string;
  fileSize: number;
  fileHash: string;
  tags?: string[];
  avatar?: string;
}

export interface User {
  id: string;
  username: string;
  createdAt: number;
}

export interface ManagedTag {
  id: string;
  userId: string;
  name: string;
  createdAt: number;
}

export interface ManagedAgentType {
  id: string;
  userId: string;
  name: string;
  backupDirs: string[];
  createdAt: number;
}