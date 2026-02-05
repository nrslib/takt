/**
 * Session state management tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadSessionState,
  saveSessionState,
  clearSessionState,
  getSessionStatePath,
  type SessionState,
} from '../infra/config/project/sessionState.js';

describe('sessionState', () => {
  const testDir = join(__dirname, '__temp_session_state_test__');

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('getSessionStatePath', () => {
    it('should return correct path', () => {
      const path = getSessionStatePath(testDir);
      expect(path).toContain('.takt');
      expect(path).toContain('session-state.json');
    });
  });

  describe('loadSessionState', () => {
    it('should return null when file does not exist', () => {
      const state = loadSessionState(testDir);
      expect(state).toBeNull();
    });

    it('should load saved state', () => {
      const savedState: SessionState = {
        status: 'success',
        taskResult: 'Task completed successfully',
        timestamp: new Date().toISOString(),
        pieceName: 'coding',
        taskContent: 'Implement feature X',
        lastMovement: 'implement',
      };

      saveSessionState(testDir, savedState);
      const loadedState = loadSessionState(testDir);

      expect(loadedState).toEqual(savedState);
    });

    it('should return null when JSON parsing fails', () => {
      const path = getSessionStatePath(testDir);
      const configDir = join(testDir, '.takt');
      mkdirSync(configDir, { recursive: true });

      // Write invalid JSON
      const fs = require('node:fs');
      fs.writeFileSync(path, 'invalid json', 'utf-8');

      const state = loadSessionState(testDir);
      expect(state).toBeNull();
    });
  });

  describe('saveSessionState', () => {
    it('should save state correctly', () => {
      const state: SessionState = {
        status: 'success',
        taskResult: 'Task completed',
        timestamp: new Date().toISOString(),
        pieceName: 'minimal',
        taskContent: 'Test task',
        lastMovement: 'test-movement',
      };

      saveSessionState(testDir, state);

      const path = getSessionStatePath(testDir);
      expect(existsSync(path)).toBe(true);

      const loaded = loadSessionState(testDir);
      expect(loaded).toEqual(state);
    });

    it('should save error state', () => {
      const state: SessionState = {
        status: 'error',
        errorMessage: 'Something went wrong',
        timestamp: new Date().toISOString(),
        pieceName: 'coding',
        taskContent: 'Failed task',
      };

      saveSessionState(testDir, state);
      const loaded = loadSessionState(testDir);

      expect(loaded).toEqual(state);
    });

    it('should save user_stopped state', () => {
      const state: SessionState = {
        status: 'user_stopped',
        timestamp: new Date().toISOString(),
        pieceName: 'coding',
        taskContent: 'Interrupted task',
      };

      saveSessionState(testDir, state);
      const loaded = loadSessionState(testDir);

      expect(loaded).toEqual(state);
    });
  });

  describe('clearSessionState', () => {
    it('should delete state file', () => {
      const state: SessionState = {
        status: 'success',
        timestamp: new Date().toISOString(),
        pieceName: 'coding',
      };

      saveSessionState(testDir, state);
      const path = getSessionStatePath(testDir);
      expect(existsSync(path)).toBe(true);

      clearSessionState(testDir);
      expect(existsSync(path)).toBe(false);
    });

    it('should not throw when file does not exist', () => {
      expect(() => clearSessionState(testDir)).not.toThrow();
    });
  });

  describe('integration', () => {
    it('should support one-time notification pattern', () => {
      // Save state
      const state: SessionState = {
        status: 'success',
        taskResult: 'Done',
        timestamp: new Date().toISOString(),
        pieceName: 'coding',
      };
      saveSessionState(testDir, state);

      // Load once
      const loaded1 = loadSessionState(testDir);
      expect(loaded1).toEqual(state);

      // Clear immediately
      clearSessionState(testDir);

      // Load again - should be null
      const loaded2 = loadSessionState(testDir);
      expect(loaded2).toBeNull();
    });

    it('should handle truncated strings', () => {
      const longString = 'a'.repeat(2000);
      const state: SessionState = {
        status: 'success',
        taskResult: longString,
        timestamp: new Date().toISOString(),
        pieceName: 'coding',
        taskContent: longString,
      };

      saveSessionState(testDir, state);
      const loaded = loadSessionState(testDir);

      expect(loaded).toEqual(state);
    });
  });
});
