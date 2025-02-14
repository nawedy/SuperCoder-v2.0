import { useEffect, useState } from 'react';
import { GCPAIService } from '../ai/gcp-ai-service';
import { MonitoringService } from '../monitoring/monitoring-service';
import { AuditTrailService } from '../audit/audit-trail-service';
import { defaultConfig } from '../ai/model-serving-config';

export function useAIService() {
    const [aiService, setAIService] = useState<GCPAIService | null>(null);

    useEffect(() => {
        const monitor = new MonitoringService({
            projectId: process.env.GCP_PROJECT_ID!
        });
        
        const audit = new AuditTrailService({
            projectId: process.env.GCP_PROJECT_ID!
        });

        const service = new GCPAIService(
            defaultConfig,
            monitor,
            audit
        );

        setAIService(service);
    }, []);

    return aiService;
}
