import * as mysqlStore from './mysql.js';
import * as sqliteStore from './sqlite.js';

const store = process.env.SQL_DSN ? mysqlStore : sqliteStore;

// Users
export const createUser = store.createUser;
export const getUserByUsername = store.getUserByUsername;
export const getUserById = store.getUserById;
export const getAllUsers = store.getAllUsers;

// Agents
export const getAllAgents = store.getAllAgents;
export const getAgent = store.getAgent;
export const createAgent = store.createAgent;
export const updateAgent = store.updateAgent;
export const deleteAgent = store.deleteAgent;

// Version management
export const getVersions = store.getVersions;
export const getVersion = store.getVersion;
export const createVersion = store.createVersion;
export const rollbackToVersion = store.rollbackToVersion;
export const diffVersions = store.diffVersions;

// Import tracking
export const recordImport = store.recordImport;

// Marketplace & Sharing
export const getPublicAgents = store.getPublicAgents;
export const getAgentByShareToken = store.getAgentByShareToken;