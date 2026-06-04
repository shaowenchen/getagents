import * as mysqlStore from './mysql.js';
import * as sqliteStore from './sqlite.js';

const store = (process.env.SQL_DSN || '').startsWith('mysql://') ? mysqlStore : sqliteStore;

// Users
export const createUser = store.createUser;
export const getUserByUsername = store.getUserByUsername;
export const getUserById = store.getUserById;
export const getAllUsers = store.getAllUsers;
export const updateUserKeys = store.updateUserKeys;

// Agents
export const getAllAgents = store.getAllAgents;
export const getAgent = store.getAgent;
export const createAgent = store.createAgent;
export const updateAgent = store.updateAgent;
export const deleteAgent = store.deleteAgent;

// Managed tags
export const getManagedTags = store.getManagedTags;
export const createManagedTag = store.createManagedTag;
export const deleteManagedTag = store.deleteManagedTag;

// Managed agent types
export const getManagedAgentTypes = store.getManagedAgentTypes;
export const createManagedAgentType = store.createManagedAgentType;
export const updateManagedAgentType = store.updateManagedAgentType;
export const deleteManagedAgentType = store.deleteManagedAgentType;

// Version management
export const getVersions = store.getVersions;
export const getVersion = store.getVersion;
export const getPublishedVersion = store.getPublishedVersion;
export const createVersion = store.createVersion;
export const publishVersion = store.publishVersion;
export const deleteVersion = store.deleteVersion;
export const diffVersions = store.diffVersions;

// Import tracking
export const recordImport = store.recordImport;

// Marketplace & Sharing
export const getPublicAgents = store.getPublicAgents;
export const getAgentByShareToken = store.getAgentByShareToken;