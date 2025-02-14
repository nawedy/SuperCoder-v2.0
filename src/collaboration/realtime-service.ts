import { createClient, SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import { MonitoringService } from '../monitoring/monitoring-service';
import { EventBusService } from '../events/event-bus-service';
import { v4 as uuidv4 } from 'uuid';

interface CollaborationSession {
    id: string;
    projectId: string;
    participants: Participant[];
    state: SessionState;
    metadata: {
        created: Date;
        lastActive: Date;
        expiresAt: Date;
    };
}

interface Participant {
    id: string;
    role: 'owner' | 'editor' | 'viewer';
    cursor?: {
        line: number;
        column: number;
    };
    selection?: {
        start: { line: number; column: number };
        end: { line: number; column: number };
    };
    lastActive: Date;
}

interface SessionState {
    content: string;
    version: number;
    operations: Operation[];
    pending: Operation[];
}

interface Operation {
    id: string;
    type: 'insert' | 'delete' | 'replace';
    position: number;
    content?: string;
    length?: number;
    author: string;
    timestamp: Date;
}

export class RealtimeService {
    private supabase: SupabaseClient;
    private channels: Map<string, RealtimeChannel>;
    private sessions: Map<string, CollaborationSession>;
    private reconnectAttempts: Map<string, number>;
    private readonly MAX_RECONNECT_ATTEMPTS = 5;
    private readonly CLEANUP_INTERVAL = 300000; // 5 minutes

    constructor(
        private monitor: MonitoringService,
        private eventBus: EventBusService,
        config: {
            supabaseUrl: string;
            supabaseKey: string;
        }
    ) {
        this.supabase = createClient(config.supabaseUrl, config.supabaseKey);
        this.channels = new Map();
        this.sessions = new Map();
        this.reconnectAttempts = new Map();

        this.initialize();
    }

    private async initialize(): Promise<void> {
        this.startCleanupInterval();
        this.setupEventListeners();
    }

    async createSession(
        projectId: string,
        initialState: string,
        owner: string
    ): Promise<CollaborationSession> {
        try {
            const sessionId = uuidv4();
            const session: CollaborationSession = {
                id: sessionId,
                projectId,
                participants: [{
                    id: owner,
                    role: 'owner',
                    lastActive: new Date()
                }],
                state: {
                    content: initialState,
                    version: 0,
                    operations: [],
                    pending: []
                },
                metadata: {
                    created: new Date(),
                    lastActive: new Date(),
                    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
                }
            };

            // Store session in Supabase
            await this.supabase
                .from('collaboration_sessions')
                .insert([this.formatSessionForStorage(session)]);

            // Create realtime channel
            await this.createChannel(session);

            this.sessions.set(sessionId, session);

            await this.monitor.recordMetric({
                name: 'collaboration_session_created',
                value: 1,
                labels: {
                    session_id: sessionId,
                    project_id: projectId
                }
            });

            return session;

        } catch (error) {
            await this.handleError('session_creation_error', error);
            throw error;
        }
    }

    async joinSession(
        sessionId: string,
        userId: string,
        role: Participant['role'] = 'viewer'
    ): Promise<void> {
        try {
            const session = await this.getSession(sessionId);
            if (!session) {
                throw new Error('Session not found');
            }

            // Add participant
            session.participants.push({
                id: userId,
                role,
                lastActive: new Date()
            });

            // Update session in Supabase
            await this.supabase
                .from('collaboration_sessions')
                .update(this.formatSessionForStorage(session))
                .match({ id: sessionId });

            // Subscribe to channel
            await this.subscribeToChannel(sessionId, userId);

            await this.monitor.recordMetric({
                name: 'collaboration_session_joined',
                value: 1,
                labels: {
                    session_id: sessionId,
                    user_id: userId,
                    role
                }
            });

        } catch (error) {
            await this.handleError('session_join_error', error);
            throw error;
        }
    }

    async submitOperation(
        sessionId: string,
        operation: Omit<Operation, 'id' | 'timestamp'>
    ): Promise<void> {
        try {
            const session = await this.getSession(sessionId);
            if (!session) {
                throw new Error('Session not found');
            }

            const fullOperation: Operation = {
                ...operation,
                id: uuidv4(),
                timestamp: new Date()
            };

            // Apply operation optimistically
            this.applyOperation(session, fullOperation);

            // Broadcast operation
            await this.broadcastOperation(sessionId, fullOperation);

            await this.monitor.recordMetric({
                name: 'collaboration_operation_submitted',
                value: 1,
                labels: {
                    session_id: sessionId,
                    operation_type: operation.type
                }
            });

        } catch (error) {
            await this.handleError('operation_submit_error', error);
            throw error;
        }
    }

    private async createChannel(session: CollaborationSession): Promise<void> {
        const channel = this.supabase.channel(session.id);

        channel
            .on('presence', { event: 'sync' }, () => {
                this.handlePresenceSync(session.id);
            })
            .on('presence', { event: 'join' }, ({ key, newPresence }) => {
                this.handlePresenceJoin(session.id, key, newPresence);
            })
            .on('presence', { event: 'leave' }, ({ key, leftPresence }) => {
                this.handlePresenceLeave(session.id, key, leftPresence);
            })
            .subscribe(async (status) => {
                if (status === 'SUBSCRIBED') {
                    await this.handleChannelSubscribed(session.id);
                }
            });

        this.channels.set(session.id, channel);
    }

    private async subscribeToChannel(
        sessionId: string,
        userId: string
    ): Promise<void> {
        const channel = this.channels.get(sessionId);
        if (!channel) {
            throw new Error('Channel not found');
        }

        await channel.track({
            user_id: userId,
            online_at: new Date().toISOString()
        });
    }

    private async broadcastOperation(
        sessionId: string,
        operation: Operation
    ): Promise<void> {
        const channel = this.channels.get(sessionId);
        if (!channel) {
            throw new Error('Channel not found');
        }

        await channel.send({
            type: 'broadcast',
            event: 'operation',
            payload: operation
        });
    }

    private applyOperation(
        session: CollaborationSession,
        operation: Operation
    ): void {
        const state = session.state;
        
        switch (operation.type) {
            case 'insert':
                if (operation.content) {
                    state.content = 
                        state.content.slice(0, operation.position) +
                        operation.content +
                        state.content.slice(operation.position);
                }
                break;

            case 'delete':
                if (operation.length) {
                    state.content = 
                        state.content.slice(0, operation.position) +
                        state.content.slice(operation.position + operation.length);
                }
                break;

            case 'replace':
                if (operation.content && operation.length) {
                    state.content = 
                        state.content.slice(0, operation.position) +
                        operation.content +
                        state.content.slice(operation.position + operation.length);
                }
                break;
        }

        state.version++;
        state.operations.push(operation);

        // Update session
        session.metadata.lastActive = new Date();
        this.sessions.set(session.id, session);
    }

    private async handlePresenceSync(sessionId: string): Promise<void> {
        const channel = this.channels.get(sessionId);
        if (!channel) return;

        const presence = channel.presenceState();
        await this.updateParticipantsPresence(sessionId, presence);
    }

    private async handlePresenceJoin(
        sessionId: string,
        key: string,
        presence: any
    ): Promise<void> {
        await this.eventBus.publish('collaboration.presence', {
            type: 'participant_joined',
            source: 'realtime-service',
            data: {
                sessionId,
                userId: key,
                presence
            }
        });
    }

    private async handlePresenceLeave(
        sessionId: string,
        key: string,
        presence: any
    ): Promise<void> {
        await this.eventBus.publish('collaboration.presence', {
            type: 'participant_left',
            source: 'realtime-service',
            data: {
                sessionId,
                userId: key,
                presence
            }
        });
    }

    private async handleChannelSubscribed(sessionId: string): Promise<void> {
        this.reconnectAttempts.delete(sessionId);
        
        await this.monitor.recordMetric({
            name: 'collaboration_channel_subscribed',
            value: 1,
            labels: { session_id: sessionId }
        });
    }

    private async updateParticipantsPresence(
        sessionId: string,
        presence: any
    ): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        const now = new Date();
        const activeParticipants = new Set(Object.keys(presence));

        // Update participants
        session.participants = session.participants.filter(p => 
            activeParticipants.has(p.id) || p.role === 'owner'
        );

        // Update session
        await this.supabase
            .from('collaboration_sessions')
            .update(this.formatSessionForStorage(session))
            .match({ id: sessionId });
    }

    private async getSession(sessionId: string): Promise<CollaborationSession | null> {
        // Check memory cache
        const cached = this.sessions.get(sessionId);
        if (cached) return cached;

        // Get from Supabase
        const { data, error } = await this.supabase
            .from('collaboration_sessions')
            .select('*')
            .eq('id', sessionId)
            .single();

        if (error || !data) return null;

        const session = this.deserializeSession(data);
        this.sessions.set(sessionId, session);
        return session;
    }

    private formatSessionForStorage(session: CollaborationSession): any {
        return {
            ...session,
            metadata: {
                ...session.metadata,
                created: session.metadata.created.toISOString(),
                lastActive: session.metadata.lastActive.toISOString(),
                expiresAt: session.metadata.expiresAt.toISOString()
            },
            state: JSON.stringify(session.state),
            participants: JSON.stringify(session.participants)
        };
    }

    private deserializeSession(data: any): CollaborationSession {
        return {
            ...data,
            metadata: {
                ...data.metadata,
                created: new Date(data.metadata.created),
                lastActive: new Date(data.metadata.lastActive),
                expiresAt: new Date(data.metadata.expiresAt)
            },
            state: JSON.parse(data.state),
            participants: JSON.parse(data.participants)
        };
    }

    private startCleanupInterval(): void {
        setInterval(async () => {
            try {
                await this.cleanupExpiredSessions();
            } catch (error) {
                await this.handleError('cleanup_error', error);
            }
        }, this.CLEANUP_INTERVAL);
    }

    private async cleanupExpiredSessions(): Promise<void> {
        const now = new Date();
        
        for (const [sessionId, session] of this.sessions.entries()) {
            if (session.metadata.expiresAt <= now) {
                await this.terminateSession(sessionId);
            }
        }
    }

    private async terminateSession(sessionId: string): Promise<void> {
        // Remove from Supabase
        await this.supabase
            .from('collaboration_sessions')
            .delete()
            .match({ id: sessionId });

        // Close channel
        const channel = this.channels.get(sessionId);
        if (channel) {
            await channel.unsubscribe();
            this.channels.delete(sessionId);
        }

        // Clear from memory
        this.sessions.delete(sessionId);
        this.reconnectAttempts.delete(sessionId);

        await this.monitor.recordMetric({
            name: 'collaboration_session_terminated',
            value: 1,
            labels: { session_id: sessionId }
        });
    }

    private setupEventListeners(): void {
        this.eventBus.subscribe({
            id: 'realtime-monitor',
            topic: 'collaboration.error',
            handler: async (event) => {
                if (event.data.type === 'channel_error') {
                    await this.handleChannelError(event.data);
                }
            }
        });
    }

    private async handleChannelError(data: any): Promise<void> {
        const { sessionId } = data;
        const attempts = this.reconnectAttempts.get(sessionId) || 0;

        if (attempts < this.MAX_RECONNECT_ATTEMPTS) {
            this.reconnectAttempts.set(sessionId, attempts + 1);
            await this.reconnectChannel(sessionId);
        } else {
            await this.terminateSession(sessionId);
        }
    }

    private async reconnectChannel(sessionId: string): Promise<void> {
        const session = await this.getSession(sessionId);
        if (!session) return;

        // Close existing channel
        const existingChannel = this.channels.get(sessionId);
        if (existingChannel) {
            await existingChannel.unsubscribe();
        }

        // Create new channel
        await this.createChannel(session);
    }

    private async handleError(type: string, error: Error): Promise<void> {
        await this.monitor.recordMetric({
            name: `realtime_${type}`,
            value: 1,
            labels: { error: error.message }
        });

        await this.eventBus.publish('collaboration.error', {
            type: 'realtime.error',
            source: 'realtime-service',
            data: {
                error: error.message,
                type,
                timestamp: new Date()
            }
        });
    }
}
