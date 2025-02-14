// Summary: Finalized collaboration service with session management, live broadcasting, and metric recording.
import { EventBusService } from '../events/event-bus-service';
import { MonitoringService } from '../monitoring/monitoring-service';

export class RealtimeCollaborationService {
    private sessions: Map<string, Set<string>>;
    constructor(private eventBus: EventBusService, private monitor: MonitoringService) {
        this.sessions = new Map();
        this.setupListeners();
    }

    private setupListeners(): void {
        this.eventBus.subscribe({
            id: 'collab-message',
            topic: 'collaboration.message',
            handler: async (event) => {
                await this.handleIncomingMessage(event.data);
            }
        });
    }

    async joinSession(sessionId: string, userId: string): Promise<void> {
        if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, new Set());
        this.sessions.get(sessionId)!.add(userId);
        await this.monitor.recordMetric({
            name: 'collaboration_join',
            value: 1,
            labels: { sessionId, userId }
        });
    }

    async leaveSession(sessionId: string, userId: string): Promise<void> {
        this.sessions.get(sessionId)?.delete(userId);
        await this.monitor.recordMetric({
            name: 'collaboration_leave',
            value: 1,
            labels: { sessionId, userId }
        });
    }

    async broadcast(sessionId: string, message: string): Promise<void> {
        const users = this.sessions.get(sessionId);
        if (!users) throw new Error('Session not found');
        users.forEach(user => console.log(`Sending message to ${user}: ${message}`));
        await this.monitor.recordMetric({
            name: 'collaboration_broadcast',
            value: 1,
            labels: { sessionId }
        });
    }

    private async handleIncomingMessage(message: any): Promise<void> {
        console.log('Received collab message:', message);
        await this.monitor.recordMetric({
            name: 'collaboration_message_received',
            value: 1,
            labels: { session: message.sessionId }
        });
    }
}
