import { MonitoringService } from '../monitoring/monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { AuditTrailService } from '../audit/audit-trail-service';

type Constructor<T = any> = new (...args: any[]) => T;
type Factory<T = any> = (...args: any[]) => T | Promise<T>;
type Dependency = Constructor | Factory | any;

interface ServiceDefinition {
    token: string;
    dependency: Dependency;
    lifecycle: 'singleton' | 'transient';
    lazy: boolean;
    dependencies: string[];
    tags: string[];
    factory?: Factory;
    initialize?: () => Promise<void>;
    validate?: () => Promise<boolean>;
}

interface CircularDependencyError extends Error {
    chain: string[];
}

export class ContainerService {
    private services: Map<string, ServiceDefinition>;
    private instances: Map<string, any>;
    private monitor: MonitoringService;
    private eventBus: EventBusService;
    private audit: AuditTrailService;
    private initializing: boolean;
    private initializationOrder: string[];

    constructor(
        monitor: MonitoringService,
        eventBus: EventBusService,
        audit: AuditTrailService
    ) {
        this.services = new Map();
        this.instances = new Map();
        this.monitor = monitor;
        this.eventBus = eventBus;
        this.audit = audit;
        this.initializing = false;
        this.initializationOrder = [];
    }

    async register<T>(
        token: string,
        dependency: Constructor<T> | Factory<T>,
        options: {
            lifecycle?: 'singleton' | 'transient';
            lazy?: boolean;
            dependencies?: string[];
            tags?: string[];
            factory?: Factory<T>;
            initialize?: () => Promise<void>;
            validate?: () => Promise<boolean>;
        } = {}
    ): Promise<void> {
        try {
            if (this.services.has(token)) {
                throw new Error(`Service already registered: ${token}`);
            }

            const definition: ServiceDefinition = {
                token,
                dependency,
                lifecycle: options.lifecycle || 'singleton',
                lazy: options.lazy || false,
                dependencies: options.dependencies || [],
                tags: options.tags || [],
                factory: options.factory,
                initialize: options.initialize,
                validate: options.validate
            };

            // Validate dependencies
            await this.validateDependencies(definition);

            this.services.set(token, definition);

            await this.audit.logEvent({
                eventType: 'system.config',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: {}
                },
                resource: {
                    type: 'dependency',
                    id: token,
                    action: 'register'
                },
                context: {
                    location: 'container-service',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: {
                    lifecycle: definition.lifecycle,
                    dependencies: definition.dependencies
                }
            });

        } catch (error) {
            await this.handleError('service_registration_error', error);
            throw error;
        }
    }

    async get<T>(token: string): Promise<T> {
        try {
            // Check if service is registered
            const definition = this.services.get(token);
            if (!definition) {
                throw new Error(`Service not found: ${token}`);
            }

            // Return cached instance for singletons
            if (definition.lifecycle === 'singleton' && this.instances.has(token)) {
                return this.instances.get(token);
            }

            // Create new instance
            const instance = await this.createInstance<T>(definition);

            // Cache singleton instances
            if (definition.lifecycle === 'singleton') {
                this.instances.set(token, instance);
            }

            return instance;

        } catch (error) {
            await this.handleError('service_resolution_error', error);
            throw error;
        }
    }

    async getByTag<T>(tag: string): Promise<T[]> {
        try {
            const services = Array.from(this.services.entries())
                .filter(([_, def]) => def.tags.includes(tag));

            return Promise.all(
                services.map(([token]) => this.get<T>(token))
            );

        } catch (error) {
            await this.handleError('tag_resolution_error', error);
            throw error;
        }
    }

    async initialize(): Promise<void> {
        if (this.initializing) {
            throw new Error('Container is already initializing');
        }

        this.initializing = true;
        const startTime = Date.now();

        try {
            // Sort services by dependency order
            this.initializationOrder = this.resolveDependencyOrder();

            // Initialize services
            for (const token of this.initializationOrder) {
                const definition = this.services.get(token)!;
                
                if (!definition.lazy) {
                    const instance = await this.get(token);
                    
                    // Run initialization if provided
                    if (definition.initialize) {
                        await definition.initialize.call(instance);
                    }

                    // Validate if provided
                    if (definition.validate) {
                        const valid = await definition.validate.call(instance);
                        if (!valid) {
                            throw new Error(`Validation failed for service: ${token}`);
                        }
                    }
                }
            }

            await this.monitor.recordMetric({
                name: 'container_initialization',
                value: Date.now() - startTime,
                labels: {
                    services: this.services.size.toString(),
                    initialized: this.instances.size.toString()
                }
            });

        } catch (error) {
            await this.handleError('container_initialization_error', error);
            throw error;
        } finally {
            this.initializing = false;
        }
    }

    private async createInstance<T>(definition: ServiceDefinition): Promise<T> {
        // Resolve dependencies first
        const resolvedDeps = await Promise.all(
            definition.dependencies.map(dep => this.get(dep))
        );

        // Create instance using factory or constructor
        let instance: T;
        if (definition.factory) {
            instance = await definition.factory(...resolvedDeps);
        } else if (typeof definition.dependency === 'function') {
            instance = new definition.dependency(...resolvedDeps);
        } else {
            instance = definition.dependency;
        }

        return instance;
    }

    private resolveDependencyOrder(): string[] {
        const visited = new Set<string>();
        const visiting = new Set<string>();
        const sorted: string[] = [];

        const visit = (token: string, chain: string[] = []): void => {
            if (visiting.has(token)) {
                const error = new Error('Circular dependency detected') as CircularDependencyError;
                error.chain = [...chain, token];
                throw error;
            }

            if (visited.has(token)) return;

            visiting.add(token);
            const definition = this.services.get(token)!;

            for (const dep of definition.dependencies) {
                visit(dep, [...chain, token]);
            }

            visiting.delete(token);
            visited.add(token);
            sorted.push(token);
        };

        for (const [token] of this.services) {
            if (!visited.has(token)) {
                visit(token);
            }
        }

        return sorted;
    }

    private async validateDependencies(definition: ServiceDefinition): Promise<void> {
        // Check if all dependencies are registered
        for (const dep of definition.dependencies) {
            if (!this.services.has(dep)) {
                throw new Error(`Dependency not found: ${dep}`);
            }
        }

        // Check for circular dependencies
        try {
            this.resolveDependencyOrder();
        } catch (error) {
            if ((error as CircularDependencyError).chain) {
                throw new Error(
                    `Circular dependency detected: ${(error as CircularDependencyError).chain.join(' -> ')}`
                );
            }
            throw error;
        }
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });

        await this.eventBus.publish('container.error', {
            type: 'container.error',
            source: 'container-service',
            data: {
                error: error.message,
                timestamp: new Date()
            },
            metadata: {
                severity: 'high',
                environment: process.env.NODE_ENV || 'development'
            }
        });
    }

    // Cleanup method for proper service shutdown
    async shutdown(): Promise<void> {
        // Shutdown services in reverse initialization order
        for (const token of [...this.initializationOrder].reverse()) {
            const instance = this.instances.get(token);
            if (instance && typeof instance.shutdown === 'function') {
                await instance.shutdown();
            }
        }

        this.instances.clear();
        await this.eventBus.publish('container.shutdown', {
            type: 'container.shutdown',
            source: 'container-service',
            data: {
                timestamp: new Date()
            },
            metadata: {
                environment: process.env.NODE_ENV || 'development'
            }
        });
    }
}
