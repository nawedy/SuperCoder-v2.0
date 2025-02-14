import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { MonitoringService } from '../monitoring/monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { createClient as createRedisClient } from 'redis';
import { v4 as uuidv4 } from 'uuid';

interface CollaborationSession {
    id: string;
    projectId: string;
    createdBy: string;
    participants: Set<string>;
    status: 'active' | 'paused' | 'ended';
    metadata: {
        created: Date;
        lastActivity: Date;
        type: 'pair' | 'group';
        mode: 'editing' | 'reviewing';
    };
}

interface CollaborationEvent {
    id: string;
    sessionId: string;
    type: 'cursor' | 'selection' | 'edit' | 'comment';
    userId: string;
    data: any;
    timestamp: Date;
}

interface CursorPosition {
    userId: string;
    file: string;
    line: number;
    column: number;
    timestamp: Date;
}

interface TextSelection {
    userId: string;
    file: string;
    start: { line: number; column: number };
    end: { line: number; column: number };
    timestamp: Date;
}

interface TextEdit {
    userId: string;
    file: string;
    changes: Array<{
        range: {
            start: { line: number; column: number };
            end: { line: number; column: number };
        };
        text: string;
    }>;
    timestamp: Date;
}

export class RealTimeCollaborationService {
    private supabase: any;
    private redis: ReturnType<typeof createRedisClient>;
    private sessions: Map<string, CollaborationSession>;
    private cursors: Map<string, Map<string, CursorPosition>>;
    private selections: Map<string, Map<string, TextSelection>>;
    private readonly CLEANUP_INTERVAL = 300000; // 5 minutes
    private readonly SESSION_TIMEOUT = 3600000; // 1 hour

    constructor(
        private monitor: MonitoringService,
        private eventBus: EventBusService,
        private config: {
            supabaseUrl: string;
            supabaseKey: string;
            redisUrl: string;
        }
    ) {
        this.supabase = createSupabaseClient(
            config.supabaseUrl,
            config.supabaseKey
        );
        this.redis = createRedisClient({ url: config.redisUrl });
        this.sessions = new Map();
        this.cursors = new Map();
        this.selections = new Map();
        this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.redis.connect();
        this.setupRealtimeSubscription();
        this.startCleanupInterval();
        this.setupEventListeners();
    }

    async createSession(
        projectId: string,
        userId: string,
        options: {
            type?: 'pair' | 'group';
            mode?: 'editing' | 'reviewing';
        } = {}
    ): Promise<string> {
        const sessionId = uuidv4();
        const session: CollaborationSession = {
            id: sessionId,
            projectId,
            createdBy: userId,
            participants: new Set([userId]),
            status: 'active',
            metadata: {
                created: new Date(),
                lastActivity: new Date(),
                type: options.type || 'pair',
                mode: options.mode || 'editing'
            }
        };

        await this.storeSession(session);
        await this.notifySessionCreated(session);

        return sessionId;
    }

    async joinSession(sessionId: string, userId: string): Promise<void> {
        const session = await this.getSession(sessionId);
        if (!session) {
            throw new Error('Session not found');
        }

        if (session.status !== 'active') {
            throw new Error('Session is not active');
        }

        session.participants.add(userId);
        session.metadata.lastActivity = new Date();

        await this.storeSession(session);
        await this.notifyParticipantJoined(session, userId);
    }

    async leaveSession(sessionId: string, userId: string): Promise<void> {
        const session = await this.getSession(sessionId);
        if (!session) return;

        session.participants.delete(userId);
        session.metadata.lastActivity = new Date();

        if (session.participants.size === 0) {
            session.status = 'ended';
        }

        await this.storeSession(session);
        await this.notifyParticipantLeft(session, userId);
    }

    async updateCursor(
        sessionId: string,
        userId: string,
        position: Omit<CursorPosition, 'userId' | 'timestamp'>
    ): Promise<void> {
        const session = await this.getSession(sessionId);
        if (!session || !session.participants.has(userId)) return;

        const cursorPosition: CursorPosition = {
            ...position,
            userId,
            timestamp: new Date()
        };

        let sessionCursors = this.cursors.get(sessionId);
        if (!sessionCursors) {
            sessionCursors = new Map();
            this.cursors.set(sessionId, sessionCursors);
        }

        sessionCursors.set(userId, cursorPosition);
        await this.broadcastEvent(sessionId, {
            type: 'cursor',
            userId,
            data: cursorPosition
        });
    }

    async updateSelection(
        sessionId: string,
        userId: string,
        selection: Omit<TextSelection, 'userId' | 'timestamp'>
    ): Promise<void> {
        const session = await this.getSession(sessionId);
        if (!session || !session.participants.has(userId)) return;

        const textSelection: TextSelection = {
            ...selection,
            userId,
            timestamp: new Date()
        };

        let sessionSelections = this.selections.get(sessionId);
        if (!sessionSelections) {
            sessionSelections = new Map();
            this.selections.set(sessionId, sessionSelections);
        }

        sessionSelections.set(userId, textSelection);
        await this.broadcastEvent(sessionId, {
            type: 'selection',
            userId,
            data: textSelection
        });
    }

    async applyEdit(
        sessionId: string,
        userId: string,
        edit: Omit<TextEdit, 'userId' | 'timestamp'>
    ): Promise<void> {
        const session = await this.getSession(sessionId);
        if (!session || !session.participants.has(userId)) return;

        const textEdit: TextEdit = {
            ...edit,
            userId,
            timestamp: new Date()
        };

        await this.broadcastEvent(sessionId, {
            type: 'edit',
            userId,
            data: textEdit
        });

        // Store edit history
        await this.storeEdit(sessionId, textEdit);
    }

    private async getSession(sessionId: string): Promise<CollaborationSession | null> {
        const session = this.sessions.get(sessionId);
        if (session) return session;

        const stored = await this.redis.get(`session:${sessionId}`);
        if (stored) {
            const session = JSON.parse(stored);
            session.participants = new Set(session.participants);
            this.sessions.set(sessionId, session);
            return session;
        }

        return null;
    }

    private async storeSession(session: CollaborationSession): Promise<void> {
        this.sessions.set(session.id, session);
        await this.redis.set(
            `session:${session.id}`,
            JSON.stringify({
                ...session,
                participants: Array.from(session.participants)
            })
        );
    }

    private async storeEdit(sessionId: string, edit: TextEdit): Promise<void> {
        await this.supabase
            .from('collaboration_history')
            .insert([{
                session_id: sessionId,
                user_id: edit.userId,
                file: edit.file,
                changes: edit.changes,
                timestamp: edit.timestamp
            }]);
    }

    private async broadcastEvent(
        sessionId: string,
        event: Omit<CollaborationEvent, 'id' | 'sessionId' | 'timestamp'>
    ): Promise<void> {
        const collaborationEvent: CollaborationEvent = {
            id: uuidv4(),
            sessionId,
            ...event,
            timestamp: new Date()
        };

        await this.supabase
            .from('collaboration_events')
            .insert([collaborationEvent]);
    }

    private setupRealtimeSubscription(): void {
        this.supabase
            .from('collaboration_events')
            .on('INSERT', (payload: any) => {
                this.handleRealtimeEvent(payload.new);
            })
            .subscribe();
    }

    private async handleRealtimeEvent(event: CollaborationEvent): Promise<void> {
        const session = await this.getSession(event.sessionId);
        if (!session) return;

        switch (event.type) {
            case 'cursor':
                this.updateCursorPosition(event.sessionId, event.data);
                break;
            case 'selection':
                this.updateSelectionRange(event.sessionId, event.data);
                break;
            case 'edit':
                this.applyTextEdit(event.sessionId, event.data);
                break;
        }

        await this.notifyEventProcessed(event);
    }

    private updateCursorPosition(sessionId: string, position: CursorPosition): void {
        let sessionCursors = this.cursors.get(sessionId);
        if (!sessionCursors) {
            sessionCursors = new Map();
            this.cursors.set(sessionId, sessionCursors);
        }
        sessionCursors.set(position.userId, position);
    }

    private updateSelectionRange(sessionId: string, selection: TextSelection): void {
        let sessionSelections = this.selections.get(sessionId);
        if (!sessionSelections) {
            sessionSelections = new Map();
            this.selections.set(sessionId, sessionSelections);
        }
        sessionSelections.set(selection.userId, selection);
    }

    private applyTextEdit(sessionId: string, edit: TextEdit): void {
        // Implement operational transformation if needed
    }

    private startCleanupInterval(): void {
        setInterval(async () => {
            try {
                await this.cleanupInactiveSessions();
            } catch (error) {
                await this.handleError('cleanup_error', error);
            }
        }, this.CLEANUP_INTERVAL);
    }

    private async cleanupInactiveSessions(): Promise<void> {
        const now = Date.now();
        for (const [sessionId, session] of this.sessions) {
            if (now - session.metadata.lastActivity.getTime() > this.SESSION_TIMEOUT) {
                session.status = 'ended';
                await this.storeSession(session);
                this.sessions.delete(sessionId);
                this.cursors.delete(sessionId);
                this.selections.delete(sessionId);
            }
        }
    }

    private async notifySessionCreated(session: CollaborationSession): Promise<void> {
        await this.eventBus.publish('collaboration.session.created', {
            type: 'session.created',
            source: 'collaboration',
            data: {
                sessionId: session.id,
                projectId: session.projectId,
                createdBy: session.createdBy,
                timestamp: new Date()
            }
        });
    }

    private async notifyParticipantJoined(
        session: CollaborationSession,
        userId: string
    ): Promise<void> {
        await this.eventBus.publish('collaboration.participant.joined', {
            type: 'participant.joined',
            source: 'collaboration',
            data: {
                sessionId: session.id,
                userId,
                timestamp: new Date()
            }
        });
    }

    private async notifyParticipantLeft(
        session: CollaborationSession,
        userId: string
    ): Promise<void> {
        await this.eventBus.publish('collaboration.participant.left', {
            type: 'participant.left',
            source: 'collaboration',
            data: {
                sessionId: session.id,
                userId,
                timestamp: new Date()
            }
        });
    }

    private async notifyEventProcessed(event: CollaborationEvent): Promise<void> {
        await this.eventBus.publish('collaboration.event.processed', {
            type: 'event.processed',
            source: 'collaboration',
            data: event
        });
    }

    private setupEventListeners(): void {
        this.eventBus.subscribe({
            id: 'collaboration-monitor',
            topic: 'system.health',
            handler: async (event) => {
                if (event.data.type === 'collaboration_health_check') {
                    await this.handleHealthCheck(event.data);
                }
            }
        });
    }

    private async handleHealthCheck(data: any): Promise<void> {
        // Implement health check response
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: `collaboration_${type}`,
            value: 1,
            labels: { error: error.message }
        });

        await this.eventBus.publish('collaboration.error', {
            type: 'collaboration.error',
            source: 'collaboration',
            data: {
                error: error.message,
                type,
                timestamp: new Date()
            }
        });
    }

    async close(): Promise<void> {
        await this.redis.quit();
    }
}
