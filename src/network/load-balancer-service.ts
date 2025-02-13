import { MonitoringService } from '../monitoring/monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { ServiceDiscoveryService } from '../discovery/service-discovery-service';
import { HealthCheckService } from '../health/health-check-service';

interface LoadBalancerConfig {
    algorithm: 'round-robin' | 'least-connections' | 'weighted' | 'ip-hash';
    maxRetries: number;
    timeout: number;
    healthCheck: {
        enabled: boolean;
        interval: number;
        timeout: number;
        unhealthyThreshold: number;
        healthyThreshold: number;
    };
    session: {
        enabled: boolean;
        ttl: number;
    };
}

interface ServerNode {
    id: string;
    host: string;
    port: number;
    weight: number;
    currentConnections: number;
    totalRequests: number;
    status: 'healthy' | 'unhealthy' | 'draining';
    lastHealthCheck: Date;
    metrics: {
        responseTime: number[];
        errorRate: number;
        cpu: number;
        memory: number;
    };
}

interface SessionData {
    id: string;
    nodeId: string;
    createdAt: Date;
    lastUsed: Date;
    metadata: Record<string, any>;
}

export class LoadBalancerService {
    private monitor: MonitoringService;
    private eventBus: EventBusService;
    private discovery: ServiceDiscoveryService;
    private healthCheck: HealthCheckService;
    private nodes: Map<string, ServerNode>;
    private sessions: Map<string, SessionData>;
    private currentNodeIndex: number;
    private config: LoadBalancerConfig;
    private readonly METRICS_WINDOW = 60; // 1 minute
    private readonly CLEANUP_INTERVAL = 300000; // 5 minutes

    constructor(
        monitor: MonitoringService,
        eventBus: EventBusService,
        discovery: ServiceDiscoveryService,
        healthCheck: HealthCheckService,
        config: LoadBalancerConfig
    ) {
        this.monitor = monitor;
        this.eventBus = eventBus;
        this.discovery = discovery;
        this.healthCheck = healthCheck;
        this.config = config;
        this.nodes = new Map();
        this.sessions = new Map();
        this.currentNodeIndex = 0;

        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.discoverNodes();
        this.startHealthChecks();
        this.startMetricsCollection();
        this.startSessionCleanup();
        this.setupEventListeners();
    }

    async route(
        request: {
            id: string;
            sessionId?: string;
            clientIp: string;
            path: string;
            headers: Record<string, string>;
        }
    ): Promise<ServerNode> {
        const startTime = Date.now();
        try {
            // Check session affinity
            if (this.config.session.enabled && request.sessionId) {
                const sessionNode = await this.getSessionNode(request.sessionId);
                if (sessionNode && sessionNode.status === 'healthy') {
                    return sessionNode;
                }
            }

            // Get available nodes
            const availableNodes = Array.from(this.nodes.values())
                .filter(node => node.status === 'healthy');

            if (!availableNodes.length) {
                throw new Error('No healthy nodes available');
            }

            // Select node based on algorithm
            const node = await this.selectNode(request, availableNodes);
            
            // Update node metrics
            node.currentConnections++;
            node.totalRequests++;

            // Create session if enabled
            if (this.config.session.enabled && request.sessionId) {
                await this.createSession(request.sessionId, node.id);
            }

            // Record metrics
            await this.monitor.recordMetric({
                name: 'load_balancer_route',
                value: Date.now() - startTime,
                labels: {
                    node_id: node.id,
                    algorithm: this.config.algorithm
                }
            });

            return node;

        } catch (error) {
            await this.handleError('routing_error', error);
            throw error;
        }
    }

    async markRequestComplete(nodeId: string, responseTime: number): Promise<void> {
        const node = this.nodes.get(nodeId);
        if (!node) return;

        node.currentConnections--;
        node.metrics.responseTime.push(responseTime);

        // Keep only recent metrics
        const cutoffTime = Date.now() - (this.METRICS_WINDOW * 1000);
        node.metrics.responseTime = node.metrics.responseTime.filter(t => 
            t > cutoffTime
        );

        // Update error rate
        node.metrics.errorRate = node.metrics.responseTime.length > 0 ?
            node.metrics.responseTime.filter(t => t > this.config.timeout).length / 
            node.metrics.responseTime.length : 0;
    }

    async drainNode(nodeId: string): Promise<void> {
        const node = this.nodes.get(nodeId);
        if (!node) return;

        try {
            // Mark node as draining
            node.status = 'draining';

            // Wait for existing connections to complete
            while (node.currentConnections > 0) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            // Remove node
            this.nodes.delete(nodeId);

            await this.eventBus.publish('loadbalancer.node.drained', {
                type: 'node.drained',
                source: 'load-balancer',
                data: {
                    nodeId,
                    timestamp: new Date()
                },
                metadata: {
                    environment: process.env.NODE_ENV || 'development'
                }
            });

        } catch (error) {
            await this.handleError('node_drain_error', error);
            throw error;
        }
    }

    private async selectNode(
        request: { clientIp: string; path: string },
        nodes: ServerNode[]
    ): Promise<ServerNode> {
        switch (this.config.algorithm) {
            case 'round-robin':
                return this.selectRoundRobin(nodes);
            case 'least-connections':
                return this.selectLeastConnections(nodes);
            case 'weighted':
                return this.selectWeighted(nodes);
            case 'ip-hash':
                return this.selectIpHash(request.clientIp, nodes);
            default:
                throw new Error(`Unsupported algorithm: ${this.config.algorithm}`);
        }
    }

    private selectRoundRobin(nodes: ServerNode[]): ServerNode {
        const node = nodes[this.currentNodeIndex];
        this.currentNodeIndex = (this.currentNodeIndex + 1) % nodes.length;
        return node;
    }

    private selectLeastConnections(nodes: ServerNode[]): ServerNode {
        return nodes.reduce((min, node) => 
            node.currentConnections < min.currentConnections ? node : min
        );
    }

    private selectWeighted(nodes: ServerNode[]): ServerNode {
        const totalWeight = nodes.reduce((sum, node) => sum + node.weight, 0);
        let random = Math.random() * totalWeight;

        for (const node of nodes) {
            random -= node.weight;
            if (random <= 0) return node;
        }

        return nodes[0];
    }

    private selectIpHash(clientIp: string, nodes: ServerNode[]): ServerNode {
        const hash = this.hashString(clientIp);
        return nodes[hash % nodes.length];
    }

    private hashString(str: string): number {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash = hash & hash;
        }
        return Math.abs(hash);
    }

    private async getSessionNode(sessionId: string): Promise<ServerNode | null> {
        const session = this.sessions.get(sessionId);
        if (!session) return null;

        const node = this.nodes.get(session.nodeId);
        if (!node) return null;

        // Update session
        session.lastUsed = new Date();
        return node;
    }

    private async createSession(
        sessionId: string,
        nodeId: string
    ): Promise<void> {
        const session: SessionData = {
            id: sessionId,
            nodeId,
            createdAt: new Date(),
            lastUsed: new Date(),
            metadata: {}
        };

        this.sessions.set(sessionId, session);
    }

    private async discoverNodes(): Promise<void> {
        try {
            const services = await this.discovery.discoverService({
                type: 'backend',
                status: 'running'
            });

            for (const service of services) {
                this.nodes.set(service.id, {
                    id: service.id,
                    host: service.host,
                    port: service.port,
                    weight: 1,
                    currentConnections: 0,
                    totalRequests: 0,
                    status: 'healthy',
                    lastHealthCheck: new Date(),
                    metrics: {
                        responseTime: [],
                        errorRate: 0,
                        cpu: 0,
                        memory: 0
                    }
                });
            }
        } catch (error) {
            await this.handleError('node_discovery_error', error);
        }
    }

    private startHealthChecks(): void {
        if (!this.config.healthCheck.enabled) return;

        setInterval(async () => {
            for (const node of this.nodes.values()) {
                try {
                    const health = await this.healthCheck.checkNode({
                        host: node.host,
                        port: node.port,
                        timeout: this.config.healthCheck.timeout
                    });

                    node.status = health.healthy ? 'healthy' : 'unhealthy';
                    node.lastHealthCheck = new Date();
                    node.metrics.cpu = health.metrics.cpu;
                    node.metrics.memory = health.metrics.memory;

                } catch (error) {
                    await this.handleError('health_check_error', error);
                }
            }
        }, this.config.healthCheck.interval);
    }

    private startMetricsCollection(): void {
        setInterval(async () => {
            for (const node of this.nodes.values()) {
                await this.monitor.recordMetric({
                    name: 'node_metrics',
                    value: 1,
                    labels: {
                        node_id: node.id,
                        connections: node.currentConnections.toString(),
                        error_rate: node.metrics.errorRate.toString(),
                        status: node.status
                    }
                });
            }
        }, 60000); // Every minute
    }

    private startSessionCleanup(): void {
        if (!this.config.session.enabled) return;

        setInterval(() => {
            const now = Date.now();
            for (const [sessionId, session] of this.sessions.entries()) {
                if (now - session.lastUsed.getTime() > this.config.session.ttl * 1000) {
                    this.sessions.delete(sessionId);
                }
            }
        }, this.CLEANUP_INTERVAL);
    }

    private setupEventListeners(): void {
        this.eventBus.subscribe({
            id: 'load-balancer-monitor',
            topic: 'node.status',
            handler: async (event) => {
                const { nodeId, status } = event.data;
                const node = this.nodes.get(nodeId);
                if (node) {
                    node.status = status;
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

        await this.eventBus.publish('loadbalancer.error', {
            type: 'loadbalancer.error',
            source: 'load-balancer',
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

    async shutdown(): Promise<void> {
        // Drain all nodes
        for (const [nodeId] of this.nodes.entries()) {
            await this.drainNode(nodeId);
        }

        this.nodes.clear();
        this.sessions.clear();
    }
}
