import { ConversationMessage } from '@/types/index.js';
import { createLogger, type Logger } from '../infrastructure/logger.js';
import type { RawJsonEntry } from './claude-history-types.js';

export interface ConversationChain {
  sessionId: string;
  messages: ConversationMessage[];
  projectPath: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  totalDuration: number;
  model: string;
}

interface FileCache {
  entries: RawJsonEntry[];     // Parsed JSONL entries from this file
  mtime: number;              // File modification time when cached
  sourceProject: string;      // Project directory name
}

interface ConversationCacheData {
  fileCache: Map<string, FileCache>; // filePath -> cached file data
  lastCacheTime: number;
  accessOrder: string[]; // LRU tracking: most recently accessed at end
}

// Maximum number of files to keep in cache (LRU eviction beyond this)
// This needs to be large enough to hold archived sessions for cache hits
const MAX_CACHED_FILES = 2000;

// How many files to parse in parallel (higher = faster cold cache but more memory pressure)
const PARALLEL_PARSE_BATCH_SIZE = 100;

/**
 * Service for managing conversation cache with file modification tracking
 */
export class ConversationCache {
  private cache: ConversationCacheData | null = null;
  private logger: Logger;
  private parsingPromises: Map<string, Promise<ConversationChain[]>> = new Map();

  constructor() {
    this.logger = createLogger('ConversationCache');
  }

  /**
   * Clear the conversation cache to force a refresh on next read
   */
  clear(): void {
    this.logger.debug('Clearing conversation cache');
    const previousStats = this.cache ? {
      cachedFileCount: this.cache.fileCache.size,
      totalEntries: Array.from(this.cache.fileCache.values())
        .reduce((sum, cache) => sum + cache.entries.length, 0)
    } : { cachedFileCount: 0, totalEntries: 0 };
    
    this.cache = null;
    this.parsingPromises.clear();
    this.logger.info('Conversation cache cleared', { 
      previousStats,
      timestamp: new Date().toISOString() 
    });
  }

  /**
   * Get cached file entries, combining cached and newly parsed entries
   */
  async getCachedFileEntries(
    currentFileModTimes: Map<string, number>,
    parseFileFunction: (filePath: string) => Promise<RawJsonEntry[]>,
    getSourceProject: (filePath: string) => string
  ): Promise<(RawJsonEntry & { sourceProject: string })[]> {
    this.logger.debug('Getting cached file entries', {
      hasCachedData: !!this.cache,
      currentFileCount: currentFileModTimes.size
    });

    // Initialize cache if it doesn't exist
    if (!this.cache) {
      this.cache = {
        fileCache: new Map(),
        lastCacheTime: Date.now(),
        accessOrder: []
      };
    }

    const allEntries: (RawJsonEntry & { sourceProject: string })[] = [];
    let filesFromCache = 0;
    let filesReparsed = 0;

    // Separate files into cached (fast) and need-to-parse (slow)
    const cachedFiles: Array<{ filePath: string; cached: FileCache }> = [];
    const filesToParse: Array<{ filePath: string; mtime: number }> = [];

    for (const [filePath, currentMtime] of currentFileModTimes) {
      const cached = this.cache.fileCache.get(filePath);
      if (cached && cached.mtime === currentMtime) {
        cachedFiles.push({ filePath, cached });
      } else {
        filesToParse.push({ filePath, mtime: currentMtime });
      }
    }

    // Process cached files immediately (fast, in-memory)
    for (const { filePath, cached } of cachedFiles) {
      const entriesWithSource = cached.entries.map(entry => ({
        ...entry,
        sourceProject: cached.sourceProject
      }));
      allEntries.push(...entriesWithSource);
      filesFromCache++;
      this.touchLRU(filePath);
    }

    // Parse uncached files in parallel batches
    if (filesToParse.length > 0) {
      this.logger.debug('Parsing files in parallel', {
        filesToParse: filesToParse.length,
        batchSize: PARALLEL_PARSE_BATCH_SIZE
      });

      // Process in batches to avoid overwhelming the filesystem
      for (let i = 0; i < filesToParse.length; i += PARALLEL_PARSE_BATCH_SIZE) {
        const batch = filesToParse.slice(i, i + PARALLEL_PARSE_BATCH_SIZE);

        const results = await Promise.all(
          batch.map(async ({ filePath, mtime }) => {
            try {
              const entries = await parseFileFunction(filePath);
              const sourceProject = getSourceProject(filePath);
              return { filePath, entries, mtime, sourceProject, success: true as const };
            } catch (error) {
              this.logger.warn('Failed to parse file, skipping', { filePath, error });
              return { filePath, success: false as const };
            }
          })
        );

        // Process results
        for (const result of results) {
          if (result.success) {
            // Update cache
            this.cache.fileCache.set(result.filePath, {
              entries: result.entries,
              mtime: result.mtime,
              sourceProject: result.sourceProject
            });
            this.touchLRU(result.filePath);

            const entriesWithSource = result.entries.map(entry => ({
              ...entry,
              sourceProject: result.sourceProject
            }));
            allEntries.push(...entriesWithSource);
            filesReparsed++;
          } else {
            this.cache.fileCache.delete(result.filePath);
            this.removeLRU(result.filePath);
          }
        }
      }
    }

    // Evict oldest entries if cache exceeds limit
    this.evictIfNeeded();

    // Clean up cache entries for files that no longer exist
    for (const [cachedFilePath] of this.cache.fileCache) {
      if (!currentFileModTimes.has(cachedFilePath)) {
        this.logger.debug('Removing cache entry for deleted file', { filePath: cachedFilePath });
        this.cache.fileCache.delete(cachedFilePath);
        this.removeLRU(cachedFilePath);
      }
    }

    this.logger.debug('File cache processing complete', {
      totalFiles: currentFileModTimes.size,
      filesFromCache,
      filesReparsed,
      totalEntries: allEntries.length,
      cachedFileCount: this.cache.fileCache.size,
      cacheHitRate: currentFileModTimes.size > 0
        ? `${Math.round(filesFromCache / currentFileModTimes.size * 100)}%`
        : 'N/A'
    });

    return allEntries;
  }

  /**
   * Update a specific file's cache entry
   */
  updateFileCache(
    filePath: string,
    entries: RawJsonEntry[],
    mtime: number,
    sourceProject: string
  ): void {
    if (!this.cache) {
      this.cache = {
        fileCache: new Map(),
        lastCacheTime: Date.now(),
        accessOrder: []
      };
    }

    this.cache.fileCache.set(filePath, {
      entries,
      mtime,
      sourceProject
    });
    this.touchLRU(filePath);
    this.evictIfNeeded();

    this.logger.debug('File cache updated', {
      filePath,
      entryCount: entries.length,
      sourceProject,
      mtime: new Date(mtime).toISOString()
    });
  }

  /**
   * Clear cache entry for a specific file
   */
  clearFileCache(filePath: string): void {
    if (this.cache?.fileCache.has(filePath)) {
      this.cache.fileCache.delete(filePath);
      this.removeLRU(filePath);
      this.logger.debug('File cache cleared', { filePath });
    }
  }

  /**
   * Check if a specific file's cache entry is valid
   */
  isFileCacheValid(filePath: string, currentMtime: number): boolean {
    if (!this.cache) {
      return false;
    }

    const cached = this.cache.fileCache.get(filePath);
    return cached ? cached.mtime === currentMtime : false;
  }

  /**
   * Get or parse conversations with file-level caching and concurrency protection
   */
  async getOrParseConversations(
    currentFileModTimes: Map<string, number>,
    parseFileFunction: (filePath: string) => Promise<RawJsonEntry[]>,
    getSourceProject: (filePath: string) => string,
    processAllEntries: (allEntries: (RawJsonEntry & { sourceProject: string })[]) => ConversationChain[]
  ): Promise<ConversationChain[]> {
    // Create cache key based on file set to avoid returning wrong results for different filters
    const cacheKey = Array.from(currentFileModTimes.keys()).sort().join('|');

    this.logger.debug('Request for conversations received', {
      hasCachedData: !!this.cache,
      activeParsings: this.parsingPromises.size,
      currentFileCount: currentFileModTimes.size
    });

    // If already parsing THIS SAME file set, wait for it to complete
    const existingPromise = this.parsingPromises.get(cacheKey);
    if (existingPromise) {
      this.logger.debug('Parsing already in progress for this file set, waiting for completion', {
        fileCount: currentFileModTimes.size
      });
      try {
        const result = await existingPromise;
        this.logger.debug('Concurrent parsing completed, returning result', {
          conversationCount: result.length
        });
        return result;
      } catch (error) {
        this.logger.error('Concurrent parsing failed', error);
        // Clear the failed promise and fall through to retry
        this.parsingPromises.delete(cacheKey);
      }
    }

    const parsingPromise = this.executeFileBasedParsing(
      currentFileModTimes,
      parseFileFunction,
      getSourceProject,
      processAllEntries
    );

    this.parsingPromises.set(cacheKey, parsingPromise);

    try {
      const result = await parsingPromise;
      this.parsingPromises.delete(cacheKey);
      return result;
    } catch (error) {
      this.parsingPromises.delete(cacheKey);
      throw error;
    }
  }

  /**
   * Execute file-based parsing with proper logging
   */
  private async executeFileBasedParsing(
    currentFileModTimes: Map<string, number>,
    parseFileFunction: (filePath: string) => Promise<RawJsonEntry[]>,
    getSourceProject: (filePath: string) => string,
    processAllEntries: (allEntries: (RawJsonEntry & { sourceProject: string })[]) => ConversationChain[]
  ): Promise<ConversationChain[]> {
    const parseStartTime = Date.now();
    
    this.logger.debug('Executing file-based parsing');
    
    // Get all entries using file-level caching
    const allEntries = await this.getCachedFileEntries(
      currentFileModTimes,
      parseFileFunction,
      getSourceProject
    );
    
    // Process entries into conversations (cheap in-memory operation)
    const conversations = processAllEntries(allEntries);
    const parseElapsed = Date.now() - parseStartTime;

    this.logger.debug('File-based parsing completed', {
      conversationCount: conversations.length,
      totalEntries: allEntries.length,
      parseElapsedMs: parseElapsed
    });

    return conversations;
  }

  /**
   * Move a file to the end of the LRU order (most recently used)
   */
  private touchLRU(filePath: string): void {
    if (!this.cache) return;
    const idx = this.cache.accessOrder.indexOf(filePath);
    if (idx !== -1) {
      this.cache.accessOrder.splice(idx, 1);
    }
    this.cache.accessOrder.push(filePath);
  }

  /**
   * Remove a file from LRU tracking
   */
  private removeLRU(filePath: string): void {
    if (!this.cache) return;
    const idx = this.cache.accessOrder.indexOf(filePath);
    if (idx !== -1) {
      this.cache.accessOrder.splice(idx, 1);
    }
  }

  /**
   * Evict oldest entries if cache exceeds MAX_CACHED_FILES
   */
  private evictIfNeeded(): void {
    if (!this.cache) return;

    const toEvict = this.cache.fileCache.size - MAX_CACHED_FILES;
    if (toEvict <= 0) return;

    // Evict oldest (front of accessOrder array)
    const evicted: string[] = [];
    for (let i = 0; i < toEvict && this.cache.accessOrder.length > 0; i++) {
      const oldest = this.cache.accessOrder.shift();
      if (oldest) {
        this.cache.fileCache.delete(oldest);
        evicted.push(oldest);
      }
    }

    if (evicted.length > 0) {
      this.logger.info('LRU cache eviction', {
        evictedCount: evicted.length,
        remainingFiles: this.cache.fileCache.size,
        maxFiles: MAX_CACHED_FILES
      });
    }
  }

  /**
   * Get cache statistics for monitoring
   */
  getStats(): {
    isLoaded: boolean;
    cachedFileCount: number;
    totalCachedEntries: number;
    lastCacheTime: number | null;
    cacheAge: number | null;
    isCurrentlyParsing: boolean;
    fileCacheDetails: { filePath: string; entryCount: number; mtime: string }[];
  } {
    if (!this.cache) {
      return {
        isLoaded: false,
        cachedFileCount: 0,
        totalCachedEntries: 0,
        lastCacheTime: null,
        cacheAge: null,
        isCurrentlyParsing: this.parsingPromises.size > 0,
        fileCacheDetails: []
      };
    }

    const totalCachedEntries = Array.from(this.cache.fileCache.values())
      .reduce((sum, cache) => sum + cache.entries.length, 0);

    const fileCacheDetails = Array.from(this.cache.fileCache.entries())
      .map(([filePath, cache]) => ({
        filePath,
        entryCount: cache.entries.length,
        mtime: new Date(cache.mtime).toISOString()
      }));

    return {
      isLoaded: true,
      cachedFileCount: this.cache.fileCache.size,
      totalCachedEntries,
      lastCacheTime: this.cache.lastCacheTime,
      cacheAge: Date.now() - this.cache.lastCacheTime,
      isCurrentlyParsing: this.parsingPromises.size > 0,
      fileCacheDetails
    };
  }
}
