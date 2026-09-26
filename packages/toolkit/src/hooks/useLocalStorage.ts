import { useState, useEffect, useCallback } from 'react';
import { storage } from '../utils/storage.js';

export function useLocalStorage<T>(
  key: string,
  defaultValue: T,
): readonly [T, (newValue: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => storage.get(key, defaultValue));

  const setStoredValue = useCallback(
    (newValue: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const valueToStore = newValue instanceof Function ? newValue(prev) : newValue;
        storage.set(key, valueToStore);
        return valueToStore;
      });
    },
    [key],
  );

  // Listen for storage changes from other tabs
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === key && e.newValue) {
        try {
          setValue(JSON.parse(e.newValue) as T);
        } catch {
          // Invalid JSON
        }
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, [key]);

  return [value, setStoredValue] as const;
}
