import { MonitoringService } from '../monitoring/monitoring-service';
import { SecurityConfig } from '../config/security-config';
import { Redis } from 'ioredis';
import { AuditTrailService } from '../audit/audit-trail-service';
import { sign, verify } from 'jsonwebtoken';

interface Session {
    id: string;
    userId: string;
    createdAt: Date;
    expiresAt: Date;
    lastActivity: Date;
    metadata: {
        userAgent: string;
        ipAddress: string;
        device: string;
    };
    permissions: string[];
}

interface SessionToken {
    sessionId: string;
    userId: string;
    expiresAt: number;
}

export class SessionManagementService {
    private monitor: MonitoringService;
    private securityConfig: SecurityConfig;
    private redis: Redis;
    private audit: AuditTrailService;
    private readonly SESSION_PREFIX = 'session:';
    private readonly TOKEN_SECRET: string;
    private readonly SESSION_DURATION = 24 * 60 * 60 * 1000; // 24 hours

    constructor(
        monitor: MonitoringService,
        securityConfig: SecurityConfig,
        audit: AuditTrailService,
        redisUrl: string
    ) {
        this.monitor = monitor;
        this.securityConfig = securityConfig;
        this.audit = audit;
        this.redis = new Redis(redisUrl);
        this.TOKEN_SECRET = process.env.JWT_SECRET || 'your-secret-key';

        this.startCleanupTask();
    }

    async createSession(
        userId: string,
        metadata: Session['metadata'],
        permissions: string[]
    ): Promise<{ session: Session; token: string }> {
        try {
            const session: Session = {
                id: this.generateSessionId(),
                userId,
                createdAt: new Date(),
                expiresAt: new Date(Date.now() + this.SESSION_DURATION),
                lastActivity: new Date(),
                metadata,
                permissions
            };

            // Store session in Redis
            await this.storeSession(session);

            // Generate token
            const token = this.generateToken(session);

            await this.audit.logEvent({
                eventType: 'user.login',
                actor: {
                    id: userId,
                    type: 'user',
                    metadata: {}
                },
                resource: {
                    type: 'session',
                    id: session.id,
                    action: 'create'
                },
                context: {
                    location: 'session-management',
                    ipAddress: metadata.ipAddress,
                    userAgent: metadata.userAgent
                },
                status: 'success',
                details: { sessionId: session.id }
            });

            return { session, token };
        } catch (error) {
            await this.handleError('session_creation_error', error);
            throw error;
        }
    }

    async validateSession(token: string): Promise<Session | null> {
        try {
            // Verify token
            const decoded = await this.verifyToken(token);
            if (!decoded) return null;

            // Get session from Redis
            const session = await this.getSession(decoded.sessionId);
            if (!session) return null;

            // Check expiration
            if (new Date() > session.expiresAt) {
                await this.invalidateSession(session.id);
                return null;
            }

            // Update last activity
            session.lastActivity = new Date();
            await this.storeSession(session);

            return session;
        } catch (error) {
            await this.handleError('session_validation_error', error);
            return null;
        }
    }

    async invalidateSession(sessionId: string): Promise<void> {
        try {
            const session = await this.getSession(sessionId);
            if (!session) return;

            // Remove from Redis
            await this.redis.del(this.SESSION_PREFIX + sessionId);

            await this.audit.logEvent({
                eventType: 'user.logout',
                actor: {
                    id: session.userId,
                    type: 'user',
                    metadata: {}
                },
                resource: {
                    type: 'session',
                    id: sessionId,
                    action: 'invalidate'
                },
                context: {
                    location: 'session-management',
                    ipAddress: session.metadata.ipAddress,
                    userAgent: session.metadata.userAgent
                },
                status: 'success',
                details: { sessionId }
            });
        } catch (error) {
            await this.handleError('session_invalidation_error', error);
            throw error;
        }
    }

    async refreshSession(token: string): Promise<string | null> {
        try {
            const session = await this.validateSession(token);
            if (!session) return null;

            // Extend session expiration
            session.expiresAt = new Date(Date.now() + this.SESSION_DURATION);
            await this.storeSession(session);

            // Generate new token
            return this.generateToken(session);
        } catch (error) {
            await this.handleError('session_refresh_error', error);
            return null;
        }
    }

    private generateToken(session: Session): string {
        const payload: SessionToken = {
            sessionId: session.id,
            userId: session.userId,
            expiresAt: session.expiresAt.getTime()
        };

        return sign(payload, this.TOKEN_SECRET, {
            expiresIn: this.SESSION_DURATION / 1000
        });
    }

    private async verifyToken(token: string): Promise<SessionToken | null> {
        try {
            return verify(token, this.TOKEN_SECRET) as SessionToken;
        } catch {
            return null;
        }
    }

    private async storeSession(session: Session): Promise<void> {
        await this.redis.set(
            this.SESSION_PREFIX + session.id,
            JSON.stringify(session),
            'PX',
            this.SESSION_DURATION
        );
    }

    private async getSession(sessionId: string): Promise<Session | null> {
        const data = await this.redis.get(this.SESSION_PREFIX + sessionId);
        if (!data) return null;

        const session = JSON.parse(data);
        return {
            ...session,
            createdAt: new Date(session.createdAt),
            expiresAt: new Date(session.expiresAt),
            lastActivity: new Date(session.lastActivity)
        };
    }

    private startCleanupTask(): void {
        setInterval(async () => {
            try {
                await this.cleanupExpiredSessions();
            } catch (error) {
                await this.handleError('session_cleanup_error', error);
            }
        }, 60 * 60 * 1000); // Run every hour
    }

    private async cleanupExpiredSessions(): Promise<void> {
        const pattern = `${this.SESSION_PREFIX}*`;
        let cursor = '0';
        let cleaned = 0;

        do {
            const [nextCursor, keys] = await this.redis.scan(
                cursor,
                'MATCH',
                pattern,
                'COUNT',
                100
            );
            cursor = nextCursor;

            for (const key of keys) {
                const session = await this.getSession(key.replace(this.SESSION_PREFIX, ''));
                if (session && new Date() > session.expiresAt) {
                    await this.invalidateSession(session.id);
                    cleaned++;
                }
            }
        } while (cursor !== '0');

        await this.monitor.recordMetric({
            name: 'session_cleanup',
            value: cleaned,
            labels: { type: 'expired' }
        });
    }

    private generateSessionId(): string {
        return `sess-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: type,
            value: 1,
            labels: { error: error.message }
        });
    }
}
