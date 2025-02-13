import { MonitoringService } from '../monitoring/monitoring-service';
import { HealthCheckService } from '../monitoring/health-check-service';
import { EventBusService } from '../events/event-bus-service';
import { Redis } from 'ioredis';
import * as crypto from 'crypto';

interface ServiceNode {
    id: string;
    host: string;
    port: number;
    weight: number;
    tags: string[];
    metadata: {
        region: string;
        zone: string;
        capacity: number;
    };
    health: {
        healthy: boolean;
        lastCheck: Date;
        failureCount: number;
        latency: number;
    };
}

interface BalancingStrategy {
    type: 'round-robin' | 'least-connections' | 'weighted' | 'consistent-hash';
    config?: {
        hashKey?: string;
        weightAttribute?: string;
    };
}

interface LoadBalancerConfig {
    healthCheck: {
        interval: number;
        timeout: number;
        failureThreshold: number;
        successThreshold: number;
    };
    strategy: BalancingStrategy;
    stickiness?: {
        enabled: boolean;
        timeout: number;
    };
    maxRetries: number;
    drainTimeout: number;
}

export class LoadBalancerService {
    private monitor: MonitoringService;
    private health: HealthCheckService;
    private eventBus: EventBusService;
    private redis: Redis;
    private nodes: Map<string, ServiceNode>;
    private config: LoadBalancerConfig;
    private lastNodeIndex: number;
    private readonly consistentHashRing: Map<number, string>;
    private readonly HASH_REPLICAS = 100;

    constructor(
        monitor: MonitoringService,
        health: HealthCheckService,
        eventBus: EventBusService,
        config: LoadBalancerConfig,
        redisUrl: string
    ) {
        this.monitor = monitor;
        this.health = health;
        this.eventBus = eventBus;
        this.config = config;
        this.redis = new Redis(redisUrl);
        this.nodes = new Map();
        this.lastNodeIndex = 0;
        this.consistentHashRing = new Map();

        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.registerHealthChecks();
        this.startBackgroundTasks();
    }

    async registerNode(node: Omit<ServiceNode, 'health'>): Promise<void> {
        try {
            const nodeId = node.id || this.generateNodeId();
            
            // Create complete node object
            const newNode: ServiceNode = {
                ...node,
                id: nodeId,
                health: {
                    healthy: true,
                    lastCheck: new Date(),
                    failureCount: 0,
                    latency: 0
                }
            };

            // Store node
            this.nodes.set(nodeId, newNode);

            // Update consistent hash ring
            if (this.config.strategy.type === 'consistent-hash') {
                this.addNodeToHashRing(newNode);
            }

            // Register health check
            await this.registerNodeHealthCheck(newNode);

            await this.monitor.recordMetric({
                name: 'node_registered',
                value: 1,
                labels: {
                    node_id: nodeId,
                    region: node.metadata.region
                }
            });

        } catch (error) {
            await this.handleError('node_registration_error', error);
            throw error;
        }
    }

    async getNode(key?: string): Promise<ServiceNode> {
        try {
            if (this.nodes.size === 0) {
                throw new Error('No available nodes');
            }

            let selectedNode: ServiceNode;

            switch (this.config.strategy.type) {
                case 'round-robin':
                    selectedNode = await this.getRoundRobinNode();
                    break;
                case 'least-connections':
                    selectedNode = await this.getLeastConnectionsNode();
                    break;
                case 'weighted':
                    selectedNode = await this.getWeightedNode();
                    break;
                case 'consistent-hash':
                    if (!key) throw new Error('Hash key required for consistent hashing');
                    selectedNode = await this.getConsistentHashNode(key);
                    break;
                default:
                    throw new Error(`Unsupported balancing strategy: ${this.config.strategy.type}`);
            }

            if (!selectedNode.health.healthy) {
                throw new Error('Selected node is unhealthy');
            }

            await this.monitor.recordMetric({
                name: 'node_selected',
                value: 1,
                labels: {
                    node_id: selectedNode.id,
                    strategy: this.config.strategy.type
                }
            });

            return selectedNode;

        } catch (error) {
            await this.handleError('node_selection_error', error);
            throw error;
        }
    }

    async deregisterNode(nodeId: string, graceful: boolean = true): Promise<void> {
        try {
            const node = this.nodes.get(nodeId);
            if (!node) {
                throw new Error(`Node not found: ${nodeId}`);
            }

            if (graceful) {
                // Wait for connections to drain
                await this.drainConnections(node);
            }

            // Remove from consistent hash ring
            if (this.config.strategy.type === 'consistent-hash') {
                this.removeNodeFromHashRing(node);
            }

            // Remove node
            this.nodes.delete(nodeId);

            await this.monitor.recordMetric({
                name: 'node_deregistered',
                value: 1,
                labels: {
                    node_id: nodeId,
                    graceful: graceful.toString()
                }
            });

        } catch (error) {
            await this.handleError('node_deregistration_error', error);
            throw error;
        }
    }

    private async getRoundRobinNode(): Promise<ServiceNode> {
        const nodes = Array.from(this.nodes.values())
            .filter(node => node.health.healthy);

        if (nodes.length === 0) {
            throw new Error('No healthy nodes available');
        }

        this.lastNodeIndex = (this.lastNodeIndex + 1) % nodes.length;
        return nodes[this.lastNodeIndex];
    }

    private async getLeastConnectionsNode(): Promise<ServiceNode> {
        const nodes = Array.from(this.nodes.values())
            .filter(node => node.health.healthy)
            .sort((a, b) => a.metadata.capacity - b.metadata.capacity);

        if (nodes.length === 0) {
            throw new Error('No healthy nodes available');
        }

        return nodes[0];
    }

    private async getWeightedNode(): Promise<ServiceNode> {
        const nodes = Array.from(this.nodes.values())
            .filter(node => node.health.healthy);

        if (nodes.length === 0) {
            throw new Error('No healthy nodes available');
        }

        const totalWeight = nodes.reduce((sum, node) => sum + node.weight, 0);
        let random = Math.random() * totalWeight;

        for (const node of nodes) {
            random -= node.weight;
            if (random <= 0) {
                return node;
            }
        }

        return nodes[0];
    }

    private async getConsistentHashNode(key: string): Promise<ServiceNode> {
        const hash = this.hash(key);
        const points = Array.from(this.consistentHashRing.keys()).sort((a, b) => a - b);

        for (const point of points) {
            if (hash <= point) {
                const nodeId = this.consistentHashRing.get(point)!;
                const node = this.nodes.get(nodeId)!;
                if (node.health.healthy) {
                    return node;
                }
            }
        }

        throw new Error('No healthy node found in hash ring');
    }

    private addNodeToHashRing(node: ServiceNode): void {
        for (let i = 0; i < this.HASH_REPLICAS; i++) {
            const point = this.hash(`${node.id}-${i}`);
            this.consistentHashRing.set(point, node.id);
        }
    }

    private removeNodeFromHashRing(node: ServiceNode): void {
        for (let i = 0; i < this.HASH_REPLICAS; i++) {
            const point = this.hash(`${node.id}-${i}`);
            this.consistentHashRing.delete(point);
        }
    }

    private hash(key: string): number {
        const hash = crypto.createHash('md5').update(key).digest('hex');
        return parseInt(hash.substring(0, 8), 16);
    }

    private async registerNodeHealthCheck(node: ServiceNode): Promise<void> {
        await this.health.registerCheck({
            id: `node-${node.id}`,
            name: `Node Health Check - ${node.id}`,
            type: 'dependency',
            interval: this.config.healthCheck.interval,
            timeout: this.config.healthCheck.timeout,
            threshold: this.config.healthCheck.failureThreshold,
            check: async () => {
                const startTime = Date.now();
                try {
                    // Implement actual health check logic here
                    const healthy = await this.checkNodeHealth(node);
                    
                    node.health.latency = Date.now() - startTime;
                    node.health.lastCheck = new Date();
                    
                    if (healthy) {
                        node.health.failureCount = 0;
                        node.health.healthy = true;
                    } else {
                        node.health.failureCount++;
                        if (node.health.failureCount >= this.config.healthCheck.failureThreshold) {
                            node.health.healthy = false;
                        }
                    }

                    return healthy;
                } catch (error) {
                    node.health.failureCount++;
                    node.health.latency = Date.now() - startTime;
                    node.health.lastCheck = new Date();
                    
                    if (node.health.failureCount >= this.config.healthCheck.failureThreshold) {
                        node.health.healthy = false;
                    }

                    return false;
                }
            }
        });
    }

    private async checkNodeHealth(node: ServiceNode): Promise<boolean> {
        // Implement actual health check logic
        return true;
    }

    private async drainConnections(node: ServiceNode): Promise<void> {
        // Set node as draining
        node.health.healthy = false;

        // Wait for drain timeout
        await new Promise(resolve => setTimeout(resolve, this.config.drainTimeout));

        // Emit drain event
        await this.eventBus.publish('loadbalancer.node.drained', {
            type: 'node.drained',
            source: 'load-balancer',
            data: {
                nodeId: node.id,
                timestamp: new Date()
            },
            metadata: {
                region: node.metadata.region,
                zone: node.metadata.zone
            }
        });
    }

    private startBackgroundTasks(): void {
        // Periodic metrics collection
        setInterval(async () => {
            try {
                await this.collectMetrics();
            } catch (error) {
                await this.handleError('metrics_collection_error', error);
            }
        }, 60000); // Every minute
    }

    private async collectMetrics(): Promise<void> {
        const metrics = {
            totalNodes: this.nodes.size,
            healthyNodes: Array.from(this.nodes.values()).filter(n => n.health.healthy).length,
            averageLatency: this.calculateAverageLatency()
        };

        await this.monitor.recordMetric({
            name: 'load_balancer_stats',
            value: metrics.healthyNodes,
            labels: {
                total_nodes: metrics.totalNodes.toString(),
                avg_latency: metrics.averageLatency.toString()
            }
        });
    }

    private calculateAverageLatency(): number {
        const nodes = Array.from(this.nodes.values());
        if (nodes.length === 0) return 0;

        const totalLatency = nodes.reduce((sum, node) => sum + node.health.latency, 0);
        return totalLatency / nodes.length;
    }

    private generateNodeId(): string {
        return `node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });
    }

    // Cleanup method for proper service shutdown
    async shutdown(): Promise<void> {
        // Drain all nodes
        for (const node of this.nodes.values()) {
            await this.drainConnections(node);
        }

        // Close Redis connection
        await this.redis.quit();
    }
}
