import { MonitoringService } from '../monitoring/monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { AuditTrailService } from '../audit/audit-trail-service';
import { SecurityConfig } from '../config/security-config';
import { Redis } from 'ioredis';
import { CloudKMS } from '@google-cloud/kms';
import { v4 as uuidv4 } from 'uuid';
import * as jwt from 'jsonwebtoken';

interface SessionConfig {
    maxActiveSessions: number;
    sessionDuration: number; // seconds
    refreshTokenDuration: number; // seconds
    mfaRequired: boolean;
    inactivityTimeout: number; // seconds
    rotateRefreshToken: boolean;
}

interface SessionData {
    id: string;
    userId: string;
    roles: string[];
    permissions: string[];
    metadata: {
        createdAt: Date;
        expiresAt: Date;
        lastActive: Date;
        clientInfo: {
            ip: string;
            userAgent: string;
            device: string;
        };
    };
    mfa: {
        verified: boolean;
        method: string;
        lastVerified?: Date;
    };
    refreshToken?: {
        token: string;
        expiresAt: Date;
    };
}

interface TokenPair {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
}

export class SessionManagementService {
    private monitor: MonitoringService;
    private eventBus: EventBusService;
    private audit: AuditTrailService;
    private security: SecurityConfig;
    private redis: Redis;
    private kms: CloudKMS;
    private sessions: Map<string, SessionData>;
    private readonly CLEANUP_INTERVAL = 60000; // 1 minute
    private readonly TOKEN_SECRET: string;

    constructor(
        monitor: MonitoringService,
        eventBus: EventBusService,
        audit: AuditTrailService,
        security: SecurityConfig,
        config: {
            redisUrl: string;
            projectId: string;
            region: string;
        }
    ) {
        this.monitor = monitor;
        this.eventBus = eventBus;
        this.audit = audit;
        this.security = security;
        this.redis = new Redis(config.redisUrl);
        this.kms = new CloudKMS({ projectId: config.projectId });
        this.sessions = new Map();
        this.TOKEN_SECRET = process.env.JWT_SECRET || 'your-secret-key';

        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.loadActiveSessions();
        this.startCleanupTask();
        this.setupEventListeners();
    }

    async createSession(
        userId: string,
        clientInfo: {
            ip: string;
            userAgent: string;
            device: string;
        },
        config?: Partial<SessionConfig>
    ): Promise<TokenPair> {
        const startTime = Date.now();
        try {
            // Check active sessions limit
            await this.enforceSessionLimit(userId, config);

            // Create session
            const sessionId = uuidv4();
            const session: SessionData = {
                id: sessionId,
                userId,
                roles: await this.getUserRoles(userId),
                permissions: await this.getUserPermissions(userId),
                metadata: {
                    createdAt: new Date(),
                    expiresAt: new Date(Date.now() + this.getSessionDuration(config)),
                    lastActive: new Date(),
                    clientInfo
                },
                mfa: {
                    verified: !config?.mfaRequired,
                    method: 'none'
                }
            };

            // Generate tokens
            const tokens = await this.generateTokenPair(session);
            session.refreshToken = {
                token: tokens.refreshToken,
                expiresAt: new Date(Date.now() + this.getRefreshTokenDuration(config))
            };

            // Store session
            await this.storeSession(session);

            // Record metrics
            await this.monitor.recordMetric({
                name: 'session_created',
                value: Date.now() - startTime,
                labels: {
                    user_id: userId,
                    mfa_required: config?.mfaRequired?.toString() || 'false'
                }
            });

            // Audit log
            await this.audit.logEvent({
                eventType: 'user.login',
                actor: {
                    id: userId,
                    type: 'user',
                    metadata: { sessionId }
                },
                resource: {
                    type: 'session',
                    id: sessionId,
                    action: 'create'
                },
                context: {
                    location: 'session-management',
                    ipAddress: clientInfo.ip,
                    userAgent: clientInfo.userAgent
                },
                status: 'success',
                details: {
                    device: clientInfo.device,
                    mfa_verified: session.mfa.verified
                }
            });

            return tokens;

        } catch (error) {
            await this.handleError('session_creation_error', error);
            throw error;
        }
    }

    async validateSession(
        sessionId: string,
        accessToken: string
    ): Promise<SessionData> {
        try {
            // Get session
            const session = await this.getSession(sessionId);
            if (!session) {
                throw new Error('Session not found');
            }

            // Verify token
            const decoded = jwt.verify(accessToken, this.TOKEN_SECRET) as any;
            if (decoded.sessionId !== sessionId) {
                throw new Error('Invalid token for session');
            }

            // Check expiration
            if (session.metadata.expiresAt < new Date()) {
                await this.invalidateSession(sessionId);
                throw new Error('Session expired');
            }

            // Check inactivity
            const inactiveTime = Date.now() - session.metadata.lastActive.getTime();
            if (inactiveTime > this.security.session.inactivityTimeout * 1000) {
                await this.invalidateSession(sessionId);
                throw new Error('Session timeout due to inactivity');
            }

            // Check MFA if required
            if (this.security.mfa.enabled && !session.mfa.verified) {
                throw new Error('MFA verification required');
            }

            // Update last active time
            await this.updateSessionActivity(sessionId);

            return session;

        } catch (error) {
            await this.handleError('session_validation_error', error);
            throw error;
        }
    }

    async refreshSession(
        sessionId: string,
        refreshToken: string
    ): Promise<TokenPair> {
        try {
            // Get session
            const session = await this.getSession(sessionId);
            if (!session) {
                throw new Error('Session not found');
            }

            // Verify refresh token
            if (!session.refreshToken || 
                session.refreshToken.token !== refreshToken ||
                session.refreshToken.expiresAt < new Date()) {
                throw new Error('Invalid or expired refresh token');
            }

            // Generate new tokens
            const tokens = await this.generateTokenPair(session);

            // Rotate refresh token if configured
            if (this.security.session.rotateRefreshTokens) {
                session.refreshToken = {
                    token: tokens.refreshToken,
                    expiresAt: new Date(Date.now() + this.getRefreshTokenDuration())
                };
                await this.storeSession(session);
            }

            await this.monitor.recordMetric({
                name: 'session_refreshed',
                value: 1,
                labels: {
                    user_id: session.userId,
                    session_id: sessionId
                }
            });

            return tokens;

        } catch (error) {
            await this.handleError('session_refresh_error', error);
            throw error;
        }
    }

    async invalidateSession(sessionId: string): Promise<void> {
        try {
            const session = await this.getSession(sessionId);
            if (!session) return;

            // Remove session
            await this.redis.del(`session:${sessionId}`);
            this.sessions.delete(sessionId);

            // Audit log
            await this.audit.logEvent({
                eventType: 'user.logout',
                actor: {
                    id: session.userId,
                    type: 'user',
                    metadata: { sessionId }
                },
                resource: {
                    type: 'session',
                    id: sessionId,
                    action: 'invalidate'
                },
                context: {
                    location: 'session-management',
                    ipAddress: session.metadata.clientInfo.ip,
                    userAgent: session.metadata.clientInfo.userAgent
                },
                status: 'success',
                details: {
                    reason: 'user_logout'
                }
            });

            await this.monitor.recordMetric({
                name: 'session_invalidated',
                value: 1,
                labels: {
                    user_id: session.userId,
                    session_id: sessionId
                }
            });

        } catch (error) {
            await this.handleError('session_invalidation_error', error);
            throw error;
        }
    }

    async updateMFAStatus(
        sessionId: string,
        verified: boolean,
        method: string
    ): Promise<void> {
        try {
            const session = await this.getSession(sessionId);
            if (!session) {
                throw new Error('Session not found');
            }

            session.mfa = {
                verified,
                method,
                lastVerified: new Date()
            };

            await this.storeSession(session);

            await this.monitor.recordMetric({
                name: 'mfa_verification',
                value: 1,
                labels: {
                    user_id: session.userId,
                    session_id: sessionId,
                    method,
                    status: verified ? 'success' : 'failed'
                }
            });

        } catch (error) {
            await this.handleError('mfa_update_error', error);
            throw error;
        }
    }

    private async generateTokenPair(session: SessionData): Promise<TokenPair> {
        const accessToken = jwt.sign(
            {
                userId: session.userId,
                sessionId: session.id,
                roles: session.roles,
                permissions: session.permissions
            },
            this.TOKEN_SECRET,
            { expiresIn: this.security.session.tokenExpiration }
        );

        const refreshToken = jwt.sign(
            {
                userId: session.userId,
                sessionId: session.id,
                type: 'refresh'
            },
            this.TOKEN_SECRET,
            { expiresIn: this.security.session.refreshTokenExpiration }
        );

        return {
            accessToken,
            refreshToken,
            expiresIn: this.security.session.tokenExpiration
        };
    }

    private async storeSession(session: SessionData): Promise<void> {
        // Store in memory
        this.sessions.set(session.id, session);

        // Store in Redis
        await this.redis.set(
            `session:${session.id}`,
            JSON.stringify(session),
            'EX',
            Math.ceil((session.metadata.expiresAt.getTime() - Date.now()) / 1000)
        );
    }

    private async getSession(sessionId: string): Promise<SessionData | null> {
        // Check memory cache
        if (this.sessions.has(sessionId)) {
            return this.sessions.get(sessionId)!;
        }

        // Check Redis
        const data = await this.redis.get(`session:${sessionId}`);
        if (data) {
            const session = JSON.parse(data);
            session.metadata.createdAt = new Date(session.metadata.createdAt);
            session.metadata.expiresAt = new Date(session.metadata.expiresAt);
            session.metadata.lastActive = new Date(session.metadata.lastActive);
            if (session.mfa.lastVerified) {
                session.mfa.lastVerified = new Date(session.mfa.lastVerified);
            }
            if (session.refreshToken) {
                session.refreshToken.expiresAt = new Date(session.refreshToken.expiresAt);
            }
            this.sessions.set(sessionId, session);
            return session;
        }

        return null;
    }

    private async updateSessionActivity(sessionId: string): Promise<void> {
        const session = await this.getSession(sessionId);
        if (session) {
            session.metadata.lastActive = new Date();
            await this.storeSession(session);
        }
    }

    private async enforceSessionLimit(
        userId: string,
        config?: Partial<SessionConfig>
    ): Promise<void> {
        const maxSessions = config?.maxActiveSessions || 
            this.security.session.maxConcurrentSessions;

        const activeSessions = await this.getActiveSessionsForUser(userId);
        if (activeSessions.length >= maxSessions) {
            // Invalidate oldest session if limit reached
            const oldestSession = activeSessions.sort(
                (a, b) => a.metadata.createdAt.getTime() - b.metadata.createdAt.getTime()
            )[0];
            await this.invalidateSession(oldestSession.id);
        }
    }

    private async getActiveSessionsForUser(userId: string): Promise<SessionData[]> {
        const pattern = `session:*`;
        const keys = await this.redis.keys(pattern);
        const sessions: SessionData[] = [];

        for (const key of keys) {
            const data = await this.redis.get(key);
            if (data) {
                const session = JSON.parse(data);
                if (session.userId === userId && 
                    new Date(session.metadata.expiresAt) > new Date()) {
                    sessions.push(session);
                }
            }
        }

        return sessions;
    }

    private async loadActiveSessions(): Promise<void> {
        const pattern = `session:*`;
        const keys = await this.redis.keys(pattern);

        for (const key of keys) {
            const data = await this.redis.get(key);
            if (data) {
                const session = JSON.parse(data);
                if (new Date(session.metadata.expiresAt) > new Date()) {
                    this.sessions.set(session.id, session);
                }
            }
        }
    }

    private startCleanupTask(): void {
        setInterval(async () => {
            try {
                await this.cleanup();
            } catch (error) {
                await this.handleError('cleanup_error', error);
            }
        }, this.CLEANUP_INTERVAL);
    }

    private async cleanup(): Promise<void> {
        const now = new Date();
        let cleaned = 0;

        // Cleanup memory cache
        for (const [sessionId, session] of this.sessions.entries()) {
            if (session.metadata.expiresAt < now) {
                this.sessions.delete(sessionId);
                cleaned++;
            }
        }

        await this.monitor.recordMetric({
            name: 'session_cleanup',
            value: cleaned,
            labels: {
                cache_size: this.sessions.size.toString()
            }
        });
    }

    private async getUserRoles(userId: string): Promise<string[]> {
        // Implement role retrieval logic
        return ['user'];
    }

    private async getUserPermissions(userId: string): Promise<string[]> {
        // Implement permission retrieval logic
        return [];
    }

    private getSessionDuration(config?: Partial<SessionConfig>): number {
        return (config?.sessionDuration || this.security.session.duration) * 1000;
    }

    private getRefreshTokenDuration(config?: Partial<SessionConfig>): number {
        return (config?.refreshTokenDuration || 
            this.security.session.refreshTokenDuration) * 1000;
    }

    private setupEventListeners(): void {
        this.eventBus.subscribe({
            id: 'session-monitor',
            topic: 'user.status',
            handler: async (event) => {
                if (event.data.status === 'disabled') {
                    const sessions = await this.getActiveSessionsForUser(event.data.userId);
                    for (const session of sessions) {
                        await this.invalidateSession(session.id);
                    }
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

        await this.eventBus.publish('session.error', {
            type: 'session.error',
            source: 'session-management',
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
        this.sessions.clear();
        await this.redis.quit();
    }
}
