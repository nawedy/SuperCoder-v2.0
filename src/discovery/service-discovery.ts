import { MonitoringService } from '../monitoring/monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { AuditTrailService } from '../audit/audit-trail-service';
import { Redis } from 'ioredis';
import { Etcd3 } from 'etcd3';
import * as dns from 'dns';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';

interface ServiceInstance {
    id: string;
    name: string;
    version: string;
    host: string;
    port: number;
    status: ServiceStatus;
    metadata: {
        region: string;
        zone: string;
        environment: string;
        capabilities: string[];
        startTime: Date;
        lastHeartbeat: Date;
    };
    health: {
        status: HealthStatus;
        lastCheck: Date;
        failureCount: number;
        details: Record<string, any>;
    };
    endpoints: {
        path: string;
        method: string;
        rateLimit?: number;
        authentication: boolean;
    }[];
}

type ServiceStatus = 'starting' | 'running' | 'draining' | 'stopped';
type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

interface ServiceQuery {
    name?: string;
    version?: string;
    region?: string;
    status?: ServiceStatus;
    health?: HealthStatus;
    capabilities?: string[];
}

interface DiscoveryConfig {
    heartbeatInterval: number;
    healthCheckInterval: number;
    cleanupInterval: number;
    ttl: number;
    retries: number;
}

export class ServiceDiscoveryService {
    private monitor: MonitoringService;
    private eventBus: EventBusService;
    private audit: AuditTrailService;
    private redis: Redis;
    private etcd: Etcd3;
    private services: Map<string, ServiceInstance>;
    private healthChecks: Map<string, NodeJS.Timeout>;
    private config: DiscoveryConfig;
    private readonly lookup = promisify(dns.lookup);
    private readonly REDIS_PREFIX = 'service:';
    private readonly ETCD_PREFIX = '/services/';
    private isRunning: boolean;

    constructor(
        monitor: MonitoringService,
        eventBus: EventBusService,
        audit: AuditTrailService,
        config: {
            redisUrl: string;
            etcdHosts: string[];
            discoveryConfig?: Partial<DiscoveryConfig>;
        }
    ) {
        this.monitor = monitor;
        this.eventBus = eventBus;
        this.audit = audit;
        this.redis = new Redis(config.redisUrl);
        this.etcd = new Etcd3({ hosts: config.etcdHosts });
        this.services = new Map();
        this.healthChecks = new Map();
        this.isRunning = false;

        this.config = {
            heartbeatInterval: config.discoveryConfig?.heartbeatInterval || 30000,
            healthCheckInterval: config.discoveryConfig?.healthCheckInterval || 60000,
            cleanupInterval: config.discoveryConfig?.cleanupInterval || 300000,
            ttl: config.discoveryConfig?.ttl || 60,
            retries: config.discoveryConfig?.retries || 3
        };

        this.initialize();
    }

    private async initialize(): Promise<void> {
        try {
            await this.loadServices();
            this.startHealthChecks();
            this.startCleanup();
            this.setupEventListeners();
            this.isRunning = true;

            await this.audit.logEvent({
                eventType: 'system.config',
                actor: {
                    id: 'system',
                    type: 'service',
                    metadata: {}
                },
                resource: {
                    type: 'service-discovery',
                    id: 'initialize',
                    action: 'create'
                },
                context: {
                    location: 'service-discovery',
                    ipAddress: 'internal',
                    userAgent: 'system'
                },
                status: 'success',
                details: { config: this.config }
            });

        } catch (error) {
            await this.handleError('initialization_error', error);
            throw error;
        }
    }

    async registerService(
        service: Omit<ServiceInstance, 'id' | 'status' | 'health'>
    ): Promise<string> {
        try {
            // Validate service data
            await this.validateService(service);

            const serviceId = uuidv4();
            const instance: ServiceInstance = {
                ...service,
                id: serviceId,
                status: 'starting',
                health: {
                    status: 'healthy',
                    lastCheck: new Date(),
                    failureCount: 0,
                    details: {}
                }
            };

            // Store in memory
            this.services.set(serviceId, instance);

            // Store in Redis
            await this.storeInRedis(instance);

            // Store in etcd
            await this.storeInEtcd(instance);

            // Start health checks
            this.startInstanceHealthCheck(instance);

            await this.monitor.recordMetric({
                name: 'service_registered',
                value: 1,
                labels: {
                    service: service.name,
                    version: service.version,
                    region: service.metadata.region
                }
            });

            return serviceId;

        } catch (error) {
            await this.handleError('service_registration_error', error);
            throw error;
        }
    }

    async deregisterService(serviceId: string): Promise<void> {
        try {
            const service = this.services.get(serviceId);
            if (!service) {
                throw new Error(`Service not found: ${serviceId}`);
            }

            // Update status to draining
            service.status = 'draining';
            await this.updateService(service);

            // Wait for in-flight requests
            await new Promise(resolve => setTimeout(resolve, 5000));

            // Remove service
            this.services.delete(serviceId);
            await this.removeFromRedis(serviceId);
            await this.removeFromEtcd(serviceId);

            // Stop health checks
            this.stopInstanceHealthCheck(serviceId);

            await this.monitor.recordMetric({
                name: 'service_deregistered',
                value: 1,
                labels: {
                    service: service.name,
                    version: service.version
                }
            });

        } catch (error) {
            await this.handleError('service_deregistration_error', error);
            throw error;
        }
    }

    async discoverService(query: ServiceQuery): Promise<ServiceInstance[]> {
        try {
            let services = Array.from(this.services.values());

            // Apply filters
            if (query.name) {
                services = services.filter(s => s.name === query.name);
            }
            if (query.version) {
                services = services.filter(s => s.version === query.version);
            }
            if (query.region) {
                services = services.filter(s => s.metadata.region === query.region);
            }
            if (query.status) {
                services = services.filter(s => s.status === query.status);
            }
            if (query.health) {
                services = services.filter(s => s.health.status === query.health);
            }
            if (query.capabilities) {
                services = services.filter(s => 
                    query.capabilities!.every(cap => 
                        s.metadata.capabilities.includes(cap)
                    )
                );
            }

            // Filter out unhealthy services
            services = services.filter(s => s.health.status !== 'unhealthy');

            await this.monitor.recordMetric({
                name: 'service_discovery',
                value: services.length,
                labels: {
                    query: JSON.stringify(query)
                }
            });

            return services;

        } catch (error) {
            await this.handleError('service_discovery_error', error);
            throw error;
        }
    }

    async updateServiceHealth(
        serviceId: string,
        health: Partial<ServiceInstance['health']>
    ): Promise<void> {
        try {
            const service = this.services.get(serviceId);
            if (!service) {
                throw new Error(`Service not found: ${serviceId}`);
            }

            service.health = {
                ...service.health,
                ...health,
                lastCheck: new Date()
            };

            await this.updateService(service);

            if (service.health.status === 'unhealthy') {
                await this.eventBus.publish('service.unhealthy', {
                    type: 'service.health',
                    source: 'service-discovery',
                    data: {
                        serviceId,
                        health: service.health
                    },
                    metadata: {
                        severity: 'high',
                        timestamp: new Date()
                    }
                });
            }

        } catch (error) {
            await this.handleError('health_update_error', error);
            throw error;
        }
    }

    private async validateService(
        service: Partial<ServiceInstance>
    ): Promise<void> {
        if (!service.name || !service.version || !service.host || !service.port) {
            throw new Error('Missing required service fields');
        }

        // Validate host
        try {
            await this.lookup(service.host);
        } catch {
            throw new Error(`Invalid host: ${service.host}`);
        }

        // Validate port
        if (service.port < 0 || service.port > 65535) {
            throw new Error(`Invalid port: ${service.port}`);
        }
    }

    private async storeInRedis(service: ServiceInstance): Promise<void> {
        const key = this.REDIS_PREFIX + service.id;
        await this.redis.set(
            key,
            JSON.stringify(service),
            'EX',
            this.config.ttl
        );
    }

    private async storeInEtcd(service: ServiceInstance): Promise<void> {
        const key = this.ETCD_PREFIX + service.id;
        await this.etcd.put(key).value(JSON.stringify(service));
    }

    private async removeFromRedis(serviceId: string): Promise<void> {
        const key = this.REDIS_PREFIX + serviceId;
        await this.redis.del(key);
    }

    private async removeFromEtcd(serviceId: string): Promise<void> {
        const key = this.ETCD_PREFIX + serviceId;
        await this.etcd.delete().key(key);
    }

    private async updateService(service: ServiceInstance): Promise<void> {
        this.services.set(service.id, service);
        await this.storeInRedis(service);
        await this.storeInEtcd(service);
    }

    private async loadServices(): Promise<void> {
        try {
            // Load from etcd (primary source)
            const services = await this.etcd.getAll()
                .prefix(this.ETCD_PREFIX)
                .strings();

            for (const [_, value] of Object.entries(services)) {
                const service = JSON.parse(value) as ServiceInstance;
                this.services.set(service.id, service);
                this.startInstanceHealthCheck(service);
            }

        } catch (error) {
            await this.handleError('service_load_error', error);
            throw error;
        }
    }

    private startHealthChecks(): void {
        setInterval(async () => {
            try {
                await this.checkAllServices();
            } catch (error) {
                await this.handleError('health_check_error', error);
            }
        }, this.config.healthCheckInterval);
    }

    private async checkAllServices(): Promise<void> {
        for (const service of this.services.values()) {
            try {
                const health = await this.checkServiceHealth(service);
                await this.updateServiceHealth(service.id, health);
            } catch (error) {
                await this.handleError('service_health_check_error', error);
            }
        }
    }

    private startInstanceHealthCheck(service: ServiceInstance): void {
        const interval = setInterval(async () => {
            try {
                const health = await this.checkServiceHealth(service);
                await this.updateServiceHealth(service.id, health);
            } catch (error) {
                await this.handleError('instance_health_check_error', error);
            }
        }, this.config.healthCheckInterval);

        this.healthChecks.set(service.id, interval);
    }

    private stopInstanceHealthCheck(serviceId: string): void {
        const interval = this.healthChecks.get(serviceId);
        if (interval) {
            clearInterval(interval);
            this.healthChecks.delete(serviceId);
        }
    }

    private async checkServiceHealth(
        service: ServiceInstance
    ): Promise<Partial<ServiceInstance['health']>> {
        try {
            // Implement health check logic (e.g., HTTP health check)
            const healthy = await this.pingService(service);

            return {
                status: healthy ? 'healthy' : 'unhealthy',
                failureCount: healthy ? 0 : service.health.failureCount + 1,
                details: {
                    lastPing: new Date()
                }
            };

        } catch (error) {
            return {
                status: 'unhealthy',
                failureCount: service.health.failureCount + 1,
                details: {
                    error: error.message,
                    lastError: new Date()
                }
            };
        }
    }

    private async pingService(service: ServiceInstance): Promise<boolean> {
        // Implement actual health check logic
        return true;
    }

    private startCleanup(): void {
        setInterval(async () => {
            try {
                await this.cleanupServices();
            } catch (error) {
                await this.handleError('cleanup_error', error);
            }
        }, this.config.cleanupInterval);
    }

    private async cleanupServices(): Promise<void> {
        const now = Date.now();
        const staleThreshold = now - (this.config.ttl * 1000);

        for (const [id, service] of this.services.entries()) {
            if (service.metadata.lastHeartbeat.getTime() < staleThreshold) {
                await this.deregisterService(id);
            }
        }
    }

    private setupEventListeners(): void {
        this.eventBus.subscribe({
            id: 'service-discovery-monitor',
            topic: 'service.health',
            handler: async (event) => {
                if (event.data.health.status === 'unhealthy') {
                    await this.monitor.recordMetric({
                        name: 'service_unhealthy',
                        value: 1,
                        labels: {
                            service_id: event.data.serviceId
                        }
                    });
                }
            }
        });
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });
    }

    async shutdown(): Promise<void> {
        this.isRunning = false;

        // Stop all health checks
        for (const interval of this.healthChecks.values()) {
            clearInterval(interval);
        }
        this.healthChecks.clear();

        // Close connections
        await this.redis.quit();
        await this.etcd.close();
    }
}
