/**
 * Service Registry - Explicit initialization tracking with dependency validation.
 *
 * Solves the "singleton initialization chaos" problem where:
 * - Services depend on initialization order with no enforcement
 * - Lazy initialization can silently fail if dependencies aren't ready
 * - No visibility into which services are initialized
 *
 * USAGE:
 *
 * 1. Register services during startup:
 *    serviceRegistry.register('SessionInfoService', {
 *      dependsOn: ['ConfigService']
 *    });
 *
 * 2. Mark as initialized after async init completes:
 *    await sessionInfoService.initialize();
 *    serviceRegistry.markInitialized('SessionInfoService');
 *
 * 3. Services can guard their methods:
 *    serviceRegistry.requireInitialized('SessionInfoService');
 *
 * 4. Check status for debugging:
 *    serviceRegistry.getStatus(); // Returns all services and their state
 */

import { createLogger } from './logger.js';

export interface ServiceRegistration {
  /** Services that must be initialized before this one */
  dependsOn?: string[];
  /** Optional description for debugging */
  description?: string;
}

interface ServiceState {
  name: string;
  registered: boolean;
  initialized: boolean;
  initializedAt?: Date;
  dependsOn: string[];
  description?: string;
}

const logger = createLogger('ServiceRegistry');

class ServiceRegistry {
  private services = new Map<string, ServiceState>();

  /**
   * Register a service. Call this before initialization.
   * Validates that declared dependencies are already registered.
   */
  register(name: string, options: ServiceRegistration = {}): void {
    if (this.services.has(name)) {
      logger.warn(`Service "${name}" already registered, skipping`);
      return;
    }

    const dependsOn = options.dependsOn || [];

    // Validate dependencies are registered (but not necessarily initialized yet)
    for (const dep of dependsOn) {
      if (!this.services.has(dep)) {
        throw new Error(
          `Service "${name}" depends on "${dep}" which is not registered. ` +
          `Register dependencies before dependents.`
        );
      }
    }

    this.services.set(name, {
      name,
      registered: true,
      initialized: false,
      dependsOn,
      description: options.description
    });

    logger.debug(`Registered service: ${name}`, { dependsOn });
  }

  /**
   * Mark a service as initialized.
   * Validates that all dependencies are already initialized.
   */
  markInitialized(name: string): void {
    const state = this.services.get(name);

    if (!state) {
      throw new Error(
        `Cannot mark "${name}" as initialized - not registered. ` +
        `Call register() before markInitialized().`
      );
    }

    if (state.initialized) {
      logger.warn(`Service "${name}" already marked as initialized`);
      return;
    }

    // Validate all dependencies are initialized
    const uninitializedDeps = state.dependsOn.filter(dep => {
      const depState = this.services.get(dep);
      return !depState?.initialized;
    });

    if (uninitializedDeps.length > 0) {
      throw new Error(
        `Cannot initialize "${name}" - dependencies not initialized: ${uninitializedDeps.join(', ')}. ` +
        `Initialize dependencies first.`
      );
    }

    state.initialized = true;
    state.initializedAt = new Date();

    logger.debug(`Initialized service: ${name}`);
  }

  /**
   * Check if a service is initialized.
   */
  isInitialized(name: string): boolean {
    return this.services.get(name)?.initialized ?? false;
  }

  /**
   * Require a service to be initialized, throwing if not.
   * Use this to guard service methods.
   */
  requireInitialized(name: string): void {
    const state = this.services.get(name);

    if (!state) {
      throw new Error(
        `Service "${name}" is not registered. ` +
        `This may indicate a missing service or a typo in the service name.`
      );
    }

    if (!state.initialized) {
      const deps = state.dependsOn.length > 0
        ? ` (depends on: ${state.dependsOn.join(', ')})`
        : '';
      throw new Error(
        `Service "${name}" is not initialized${deps}. ` +
        `Ensure initialize() is called during server startup.`
      );
    }
  }

  /**
   * Get status of all registered services.
   * Useful for debugging and health checks.
   */
  getStatus(): Record<string, { initialized: boolean; dependsOn: string[]; initializedAt?: string }> {
    const status: Record<string, { initialized: boolean; dependsOn: string[]; initializedAt?: string }> = {};

    for (const [name, state] of this.services) {
      status[name] = {
        initialized: state.initialized,
        dependsOn: state.dependsOn,
        initializedAt: state.initializedAt?.toISOString()
      };
    }

    return status;
  }

  /**
   * Get list of services that aren't initialized yet.
   */
  getUninitializedServices(): string[] {
    return Array.from(this.services.entries())
      .filter(([_, state]) => !state.initialized)
      .map(([name]) => name);
  }

  /**
   * Verify all registered services are initialized.
   * Throws if any service is not initialized.
   */
  requireAllInitialized(): void {
    const uninitialized = this.getUninitializedServices();

    if (uninitialized.length > 0) {
      throw new Error(
        `The following services are not initialized: ${uninitialized.join(', ')}. ` +
        `Ensure all services complete initialization during startup.`
      );
    }
  }

  /**
   * Reset all services (for testing).
   */
  reset(): void {
    this.services.clear();
    logger.debug('Service registry reset');
  }

  /**
   * Unregister a specific service (for testing).
   */
  unregister(name: string): void {
    this.services.delete(name);
  }
}

// Singleton instance
export const serviceRegistry = new ServiceRegistry();
