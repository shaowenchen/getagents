// Core types for GetAgents — AgentHome ZIP package management platform

export interface AgentConfig {
  id: string;
  userId: string;
  name: string;
  avatar?: string;
  description: string;
  filename: string;
  fileSize: number;
  fileHash: string;
  enabled: boolean;
  tags?: string[];
  isPublic: boolean;
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
  createdAt: number;
}

export interface AgentSnapshot {
  name: string;
  description: string;
  filename: string;
  fileSize: number;
  fileHash: string;
  tags?: string[];
  avatar?: string;
}

export interface CreateAgentRequest {
  name: string;
  description: string;
  tags?: string[];
  avatar?: string;
}

export interface ShareConfig {
  token: string;
  password?: string;
  url: string;
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