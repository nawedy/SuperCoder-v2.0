import { MonitoringService } from '../monitoring/monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { BigQuery } from '@google-cloud/bigquery';
import { createClient as createRedisClient } from 'redis';
import { v8 } from 'v8';
import { performance, PerformanceObserver } from 'perf_hooks';
import { cpuUsage, memoryUsage } from 'process';
import { v4 as uuidv4 } from 'uuid';

interface ProfilingSession {
    id: string;
    type: 'cpu' | 'memory' | 'network' | 'database' | 'full';
    target: {
        service: string;
        endpoint?: string;
        function?: string;
    };
    duration: number;
    samplingRate: number;
    filters?: {
        minDuration?: number;
        excludePaths?: string[];
    };
    timestamp: Date;
}

interface ProfileData {
    sessionId: string;
    type: ProfilingSession['type'];
    metrics: {
        cpu?: {
            usage: number[];
            processes: {
                pid: number;
                usage: number;
                memory: number;
            }[];
        };
        memory?: {
            heapUsed: number[];
            heapTotal: number[];
            external: number[];
            arrayBuffers: number[];
            gc: {
                count: number;
                duration: number;
                type: string;
            }[];
        };
        network?: {
            requests: {
                url: string;
                method: string;
                duration: number;
                size: number;
                status: number;
            }[];
            connections: number;
            throughput: number;
        };
        database?: {
            queries: {
                sql: string;
                duration: number;
                rows: number;
                cache: boolean;
            }[];
            connections: number;
            poolSize: number;
        };
    };
    analysis: {
        hotspots: {
            location: string;
            type: string;
            impact: number;
            suggestion: string;
        }[];
        bottlenecks: {
            type: string;
            severity: 'high' | 'medium' | 'low';
            description: string;
            solution: string;
        }[];
        recommendations: string[];
    };
    summary: {
        duration: number;
        samples: number;
        maxMemory: number;
        avgCpu: number;
        peakLoad: number;
    };
}

export class PerformanceProfilingService {
    private redis: ReturnType<typeof createRedisClient>;
    private bigquery: BigQuery;
    private activeSessions: Map<string, {
        session: ProfilingSession;
        data: ProfileData;
        stop: () => void;
    }>;
    private observer: PerformanceObserver;
    private readonly MAX_SESSIONS = 5;
    private readonly DEFAULT_SAMPLING_RATE = 100; // ms

    constructor(
        private monitor: MonitoringService,
        private eventBus: EventBusService,
        private config: {
            projectId: string;
            redisUrl: string;
        }
    ) {
        this.redis = createRedisClient({ url: config.redisUrl });
        this.bigquery = new BigQuery({ projectId: config.projectId });
        this.activeSessions = new Map();
        this.setupPerformanceObserver();
        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.redis.connect();
        this.setupEventListeners();
    }

    private setupPerformanceObserver(): void {
        this.observer = new PerformanceObserver((list) => {
            const entries = list.getEntries();
            for (const entry of entries) {
                this.processPerformanceEntry(entry);
            }
        });

        this.observer.observe({ entryTypes: ['measure', 'mark', 'function'] });
    }

    async startProfiling(session: Omit<ProfilingSession, 'id'>): Promise<string> {
        try {
            if (this.activeSessions.size >= this.MAX_SESSIONS) {
                throw new Error('Maximum concurrent profiling sessions reached');
            }

            const sessionId = uuidv4();
            const profilingSession: ProfilingSession = {
                ...session,
                id: sessionId,
                timestamp: new Date()
            };

            const profileData: ProfileData = this.initializeProfileData(profilingSession);
            const stop = await this.startCollection(profilingSession, profileData);

            this.activeSessions.set(sessionId, {
                session: profilingSession,
                data: profileData,
                stop
            });

            // Schedule automatic stop
            setTimeout(() => {
                this.stopProfiling(sessionId).catch(error =>
                    this.handleError('auto_stop_error', error)
                );
            }, session.duration);

            return sessionId;

        } catch (error) {
            await this.handleError('start_profiling_error', error);
            throw error;
        }
    }

    async stopProfiling(sessionId: string): Promise<ProfileData> {
        const activeSession = this.activeSessions.get(sessionId);
        if (!activeSession) {
            throw new Error('Profiling session not found');
        }

        try {
            activeSession.stop();
            const finalData = await this.finalizeProfiling(
                activeSession.session,
                activeSession.data
            );
            
            await this.storeProfilingData(finalData);
            this.activeSessions.delete(sessionId);

            await this.eventBus.publish('profiling.completed', {
                type: 'profiling.completed',
                source: 'performance-profiling',
                data: {
                    sessionId,
                    summary: finalData.summary
                }
            });

            return finalData;

        } catch (error) {
            await this.handleError('stop_profiling_error', error);
            throw error;
        }
    }

    private async startCollection(
        session: ProfilingSession,
        data: ProfileData
    ): Promise<() => void> {
        const samplingRate = session.samplingRate || this.DEFAULT_SAMPLING_RATE;
        const collectors: (() => void)[] = [];

        if (session.type === 'cpu' || session.type === 'full') {
            collectors.push(this.startCPUProfiling(data, samplingRate));
        }

        if (session.type === 'memory' || session.type === 'full') {
            collectors.push(this.startMemoryProfiling(data, samplingRate));
        }

        if (session.type === 'network' || session.type === 'full') {
            collectors.push(this.startNetworkProfiling(data));
        }

        if (session.type === 'database' || session.type === 'full') {
            collectors.push(this.startDatabaseProfiling(data));
        }

        return () => collectors.forEach(stop => stop());
    }

    private startCPUProfiling(
        data: ProfileData,
        samplingRate: number
    ): () => void {
        const interval = setInterval(() => {
            const usage = cpuUsage();
            data.metrics.cpu!.usage.push(
                (usage.user + usage.system) / 1000000
            );

            // Collect process information
            const processes = this.getProcessMetrics();
            data.metrics.cpu!.processes = processes;

        }, samplingRate);

        return () => clearInterval(interval);
    }

    private startMemoryProfiling(
        data: ProfileData,
        samplingRate: number
    ): () => void {
        const interval = setInterval(() => {
            const stats = v8.getHeapStatistics();
            const memory = memoryUsage();

            data.metrics.memory!.heapUsed.push(memory.heapUsed);
            data.metrics.memory!.heapTotal.push(memory.heapTotal);
            data.metrics.memory!.external.push(memory.external);
            data.metrics.memory!.arrayBuffers.push(memory.arrayBuffers);

        }, samplingRate);

        return () => clearInterval(interval);
    }

    private startNetworkProfiling(data: ProfileData): () => void {
        const originalFetch = global.fetch;
        global.fetch = async (...args) => {
            const start = performance.now();
            try {
                const response = await originalFetch(...args);
                const duration = performance.now() - start;

                data.metrics.network!.requests.push({
                    url: args[0].toString(),
                    method: args[1]?.method || 'GET',
                    duration,
                    size: parseInt(response.headers.get('content-length') || '0'),
                    status: response.status
                });

                return response;
            } catch (error) {
                const duration = performance.now() - start;
                data.metrics.network!.requests.push({
                    url: args[0].toString(),
                    method: args[1]?.method || 'GET',
                    duration,
                    size: 0,
                    status: 0
                });
                throw error;
            }
        };

        return () => {
            global.fetch = originalFetch;
        };
    }

    private startDatabaseProfiling(data: ProfileData): () => void {
        // Implementation depends on your database client
        return () => {};
    }

    private async finalizeProfiling(
        session: ProfilingSession,
        data: ProfileData
    ): Promise<ProfileData> {
        // Calculate summary metrics
        data.summary = {
            duration: Date.now() - session.timestamp.getTime(),
            samples: data.metrics.cpu?.usage.length || 0,
            maxMemory: Math.max(...(data.metrics.memory?.heapUsed || [0])),
            avgCpu: this.calculateAverage(data.metrics.cpu?.usage || []),
            peakLoad: Math.max(...(data.metrics.cpu?.usage || [0]))
        };

        // Analyze performance data
        data.analysis = {
            hotspots: this.analyzeHotspots(data),
            bottlenecks: this.analyzeBottlenecks(data),
            recommendations: this.generateRecommendations(data)
        };

        return data;
    }

    private analyzeHotspots(data: ProfileData): ProfileData['analysis']['hotspots'] {
        const hotspots: ProfileData['analysis']['hotspots'] = [];

        // Analyze CPU hotspots
        if (data.metrics.cpu) {
            const highCPUPeriods = this.findHighUsagePeriods(
                data.metrics.cpu.usage,
                90
            );
            hotspots.push(...highCPUPeriods.map(period => ({
                location: 'CPU',
                type: 'high_usage',
                impact: period.value,
                suggestion: 'Consider optimizing CPU-intensive operations'
            })));
        }

        // Analyze memory hotspots
        if (data.metrics.memory) {
            const heapGrowth = this.calculateGrowthRate(
                data.metrics.memory.heapUsed
            );
            if (heapGrowth > 0.1) { // 10% growth rate
                hotspots.push({
                    location: 'Memory',
                    type: 'memory_leak',
                    impact: heapGrowth * 100,
                    suggestion: 'Investigate possible memory leaks'
                });
            }
        }

        // Analyze network hotspots
        if (data.metrics.network) {
            const slowRequests = data.metrics.network.requests.filter(
                req => req.duration > 1000
            );
            hotspots.push(...slowRequests.map(req => ({
                location: req.url,
                type: 'slow_request',
                impact: req.duration,
                suggestion: 'Optimize network request or implement caching'
            })));
        }

        return hotspots;
    }

    private analyzeBottlenecks(data: ProfileData): ProfileData['analysis']['bottlenecks'] {
        const bottlenecks: ProfileData['analysis']['bottlenecks'] = [];

        // Check CPU bottlenecks
        if (data.metrics.cpu) {
            const avgCPU = this.calculateAverage(data.metrics.cpu.usage);
            if (avgCPU > 80) {
                bottlenecks.push({
                    type: 'cpu_saturation',
                    severity: 'high',
                    description: 'CPU usage consistently high',
                    solution: 'Scale compute resources or optimize CPU-intensive operations'
                });
            }
        }

        // Check memory bottlenecks
        if (data.metrics.memory) {
            const memoryGrowth = this.calculateGrowthRate(
                data.metrics.memory.heapUsed
            );
            if (memoryGrowth > 0.2) {
                bottlenecks.push({
                    type: 'memory_growth',
                    severity: 'high',
                    description: 'Memory usage growing rapidly',
                    solution: 'Investigate memory leaks and implement proper cleanup'
                });
            }
        }

        // Check network bottlenecks
        if (data.metrics.network) {
            const avgRequestTime = this.calculateAverage(
                data.metrics.network.requests.map(r => r.duration)
            );
            if (avgRequestTime > 500) {
                bottlenecks.push({
                    type: 'network_latency',
                    severity: 'medium',
                    description: 'High average network request latency',
                    solution: 'Implement caching or optimize network calls'
                });
            }
        }

        return bottlenecks;
    }

    private generateRecommendations(data: ProfileData): string[] {
        const recommendations: string[] = [];

        // CPU recommendations
        if (data.metrics.cpu) {
            const highCPUUsage = data.metrics.cpu.usage.some(u => u > 90);
            if (highCPUUsage) {
                recommendations.push(
                    'Consider implementing CPU-intensive tasks in background workers'
                );
            }
        }

        // Memory recommendations
        if (data.metrics.memory) {
            const highMemoryGrowth = this.calculateGrowthRate(
                data.metrics.memory.heapUsed
            ) > 0.1;
            if (highMemoryGrowth) {
                recommendations.push(
                    'Implement memory monitoring and cleanup strategies'
                );
            }
        }

        // Network recommendations
        if (data.metrics.network && data.metrics.network.requests.length > 0) {
            const slowRequests = data.metrics.network.requests.filter(
                r => r.duration > 1000
            );
            if (slowRequests.length > 0) {
                recommendations.push(
                    'Implement request caching for frequently accessed endpoints'
                );
            }
        }

        return recommendations;
    }

    private calculateAverage(values: number[]): number {
        return values.reduce((a, b) => a + b, 0) / values.length;
    }

    private calculateGrowthRate(values: number[]): number {
        if (values.length < 2) return 0;
        const first = values[0];
        const last = values[values.length - 1];
        return (last - first) / first;
    }

    private findHighUsagePeriods(
        values: number[],
        threshold: number
    ): Array<{ start: number; end: number; value: number }> {
        const periods: Array<{ start: number; end: number; value: number }> = [];
        let start = -1;

        values.forEach((value, index) => {
            if (value > threshold && start === -1) {
                start = index;
            } else if (value <= threshold && start !== -1) {
                periods.push({
                    start,
                    end: index - 1,
                    value: Math.max(
                        ...values.slice(start, index)
                    )
                });
                start = -1;
            }
        });

        return periods;
    }

    private async storeProfilingData(data: ProfileData): Promise<void> {
        // Store in BigQuery for historical analysis
        await this.bigquery
            .dataset('profiling')
            .table('sessions')
            .insert([{
                session_id: data.sessionId,
                type: data.type,
                metrics: JSON.stringify(data.metrics),
                analysis: JSON.stringify(data.analysis),
                summary: JSON.stringify(data.summary),
                timestamp: new Date()
            }]);
    }

    private processPerformanceEntry(entry: PerformanceEntry): void {
        // Process and store performance entries
    }

    private setupEventListeners(): void {
        this.eventBus.subscribe({
            id: 'profiling-monitor',
            topic: 'system.performance',
            handler: async (event) => {
                if (event.data.type === 'performance_degradation') {
                    await this.handlePerformanceDegradation(event.data);
                }
            }
        });
    }

    private async handlePerformanceDegradation(data: any): Promise<void> {
        // Start automatic profiling session for performance investigation
        await this.startProfiling({
            type: 'full',
            target: {
                service: data.service
            },
            duration: 300000, // 5 minutes
            samplingRate: 100
        });
    }

    private async handleError(
        type: string,
        error: Error
    ): Promise<void> {
        await this.monitor.recordMetric({
            name: `profiling_${type}`,
            value: 1,
            labels: { error: error.message }
        });

        await this.eventBus.publish('profiling.error', {
            type: 'profiling.error',
            source: 'performance-profiling',
            data: {
                error: error.message,
                type,
                timestamp: new Date()
            }
        });
    }

    async close(): Promise<void> {
        // Stop all active profiling sessions
        for (const [sessionId] of this.activeSessions) {
            await this.stopProfiling(sessionId);
        }
        await this.redis.quit();
    }
}
